# Initial sync from git to Linear

The initial sync with `direction: git-to-linear` takes the Markdown files of
your repository into Linear. Git is the model: one run makes the documents
of the synchronized teams and projects equal to the synchronized folders of
the tracked branch (`main` by default), and records the state the sync
starts from. Nothing in git changes except the sync's own state refs.

> **It overwrites and trashes documents in Linear.** A document whose title
> names a file gets the file's text, even when someone changed it in Linear;
> its id, comments and history stay. A document in a synchronized team or
> project that names no file is moved to Linear's trash, from which it can be
> restored. Always start with the [dry run](#step-1-dry-run) and read what it
> lists.

How to set up the repository is in the [quickstart](quickstart.md); how
folders map to Linear and what every run checks is in [usage.md](usage.md). The
other direction, which takes Linear's documents into git through a pull
request, has [its own page](initial-sync-linear-to-git.md).

## When to use it

- Your documents live in git and Linear is empty or holds older copies:
  the first use of mdbisync for most teams.
- The sync's state was lost, or git and Linear drifted apart, and git holds
  the version you trust ([recovery](#recovery)).

When Linear holds the version to keep, use `direction: linear-to-git`
instead ([initial-sync-linear-to-git.md](initial-sync-linear-to-git.md)).

## Before you start

- Finish the setup ([quickstart](quickstart.md)) and map each folder to its
  Linear team or project in the front matter of its `README.md`
  ([folder mapping](usage.md#folder-mapping)).
- Run the `linear-format` hook over the repository (`pre-commit run
  linear-format --all-files`) and commit its fixes. A file it cannot fix is
  left out of the run ([what is left out](#what-is-left-out)).
- Disable the sync workflow (Actions → *mdbisync* → **⋯** → **Disable
  workflow**) until the initial sync has finished. Both workflows share one
  queue, and a sync queued behind a running one can replace a waiting
  initial sync.
- If documents in the synchronized teams and projects should survive, give
  each a file first, or move it to a team or project that no folder maps to.

## Inputs

The workflow template `examples/mdbisync-initial-sync.yml` asks for two
inputs when you run it from the Actions tab and passes the rest to the
action. Every input of the action, and what it means for this run:

| Input | Default | In an initial sync from git to Linear |
| --- | --- | --- |
| `operation` | `sync` | `initial-sync`; the template sets it. |
| `direction` | empty | `git-to-linear`. Required, though the action has no default: the initial sync never picks a direction itself. |
| `confirm` | empty | Only the exact value `true` writes; anything else is a dry run. |
| `linear-client-id` | none | The Linear OAuth app's client ID, from a secret. |
| `linear-client-secret` | none | Its client secret. The run mints a token from both and revokes it when it ends. |
| `linear-api-url` | empty | Linear's API origin; leave it empty. |
| `cleanup-tokens` | `false` | `true` revokes tokens that killed runs left behind, only when no other repository uses this Linear app ([README](../README.md#tokens-left-by-interrupted-jobs)). |
| `github-token` | none | The GitHub App's installation token; the run pushes the state refs with it. |
| `github-api-url` | empty | GitHub's REST API URL; leave it empty. |
| `repository` | empty | The repository as `owner/name`; empty means the workflow's own. |
| `tracked-branch` | `main` | The branch whose files Linear is made equal to. |
| `sync-branch` | `mdbisync/linear` | A confirmed run checks it for an initial sync from Linear that waits to be merged ([a run that stops](#a-run-that-stops)); the sync opens its pull request from it later. |
| `state-ref-prefix` | `refs/mdbisync` | Where the run records the state refs `ids`, `linear` and `uploads`. |
| `document-cap` | `1000` | Documents a Linear team or project may hold, trash included ([capacity](#container-document-capacity)). |
| `merge-grace-seconds` | `60` | Not used by the initial sync. |
| `report-file` | empty | A path for the run's report as JSON ([the report](#the-report-file)). |
| `security-step` | empty | `stage` or `apply` in the template's two steps. From git there is nothing for the security hooks to check, so the stage step stages nothing. |

On the command line the operation is the subcommand (`mdbisync
initial-sync`), and the other inputs are environment variables:
`MDBISYNC_DIRECTION`, `MDBISYNC_CONFIRM`, `MDBISYNC_DOCUMENT_CAP`, and so
on. `cleanup-tokens` and `security-step` exist only in the action.

## How files and documents are matched

A file's document is the live document in the file's team or project whose
title is the file's path below the mapped folder, without `.md`: in a
project mapped to `notes/`, `notes/guides/install.md` matches the document
`guides/install` ([folder mapping](usage.md#folder-mapping)). Titles are
compared after Unicode normalization (NFC). Documents in trash or archived
are ignored.

- When several live documents share a title, the oldest is the match and the
  others go to trash.
- The oldest live document that names a file the run leaves out stays as
  it is: it is neither overwritten nor trashed. Newer documents with the
  same title go to trash.

## Step 1: dry run

Run the initial sync workflow from the Actions tab with `direction:
git-to-linear` and **confirm** unchecked. It reads the tracked branch and
Linear, uploads and writes nothing, and exits with code 0 (code 3 when the
setup check fails, code 2 when an input is missing or wrong, code 5 when
Linear's rate limit stops it while it reads). Its job summary, headed **Initial sync from git to
Linear: dry run**, starts with the setup check
([usage.md](usage.md#setup-check)), counts what a confirmed run would do,
and lists it by path, never with document content:

| Table | What it means |
| --- | --- |
| Create | A file without a document. It will get a new document in the team or project in the **In Linear** column. |
| Overwrite | A file with a document. The document, named in the **Document** column by id, will get the file's text. A document that already holds it is not written. |
| Move to trash | A document without a file. The **Path** column is where its file would be. It will go to Linear's trash. |
| Left out | A file the run will not take, with the rules that stop it, the lines of `linear-format` findings, and the files it collides with or links. |
| Container document capacity | A team or project near or over its document cap. Shown only when there is one. |

Read **Move to trash** carefully. To keep a document listed there, add its
file to the tracked branch, or move the document out of the synchronized
teams and projects, and run the dry run again.

The dry run is a preview of this moment. The confirmed run plans again from
the tracked branch and Linear as they are when it starts, so a change made
in between changes what it does.

### What is left out

A file left out stays in git only, and the document its title names keeps
its text, until the reason is fixed; the next sync then takes it in. The dry
run already lists every file the confirmed run will leave out for these
reasons:

- a finding of the `linear-format` linter that `fix` cannot repair
  ([lint rules](linear-format.md#lint-rules));
- a title that collides with another file's (`duplicate-title`) or is too
  long for Linear (`title-too-long`);
- a `.md` file git does not store as text (`binary`, `stored-in-lfs`,
  `not-a-regular-file`);
- a linked file over Linear's 10 MB upload limit (`upload-too-large`) or one
  the run cannot read (`upload-unreadable`), such as an LFS object the
  remote's LFS server does not have. The dry run judges a file in Git LFS by
  its pointer and asks the LFS server only whether it holds the object; it
  downloads nothing.

The confirmed run can leave out a few more: a file whose text grows past
Linear's length limit when its links are rewritten (`content-too-long`), or
whose LFS object still cannot be read (`upload-unreadable`), for example
because the LFS server could not be reached during the dry run. Each rule and
what to do about it is in
[troubleshooting.md](troubleshooting.md#files-left-out).

### Container document capacity

A Linear team or project holds at most `document-cap` documents (1,000 by
default). Live, trashed and archived documents all count, and moving a
document to trash frees no space. The table **Container document capacity**
appears from 90%. When the planned new documents would pass the cap, a
confirmed run stops before any upload or write with `container-cap` and
exit code 5. Running it again fails the same way until a person makes room
or raises the cap
([troubleshooting.md](troubleshooting.md#container-cap)).

## Step 2: confirmed run

Run the workflow again with the same direction and **confirm** checked.

What it writes to Linear:

- a file with a document gives that document its text, without front
  matter, which stays in git; the document keeps its id, comments and
  history;
- a file without a document gets a new one in its team or project, titled
  with its path;
- images and other files a document links are uploaded once, cached by the
  SHA-256 hash of their content, and the document links Linear's copy;
- a relative link to another synchronized document becomes a link to that
  document in Linear, also when it is created in the same run; the file
  keeps the link as written;
- once every file is written, documents without a file go to Linear's
  trash. A run with a failed write trashes nothing.

What it records in git, under `state-ref-prefix`:

- `ids`, which document each file is, and `uploads`, the Linear address of
  each uploaded file, pushed every 25 documents while the run writes;
- `linear`, one commit on top of the tracked branch holding each
  synchronized file as Linear stored it, pushed once, when the run has
  written everything.

Nothing is pushed to the tracked branch. When Linear stores a file in a
different form than the tracked branch, the summary counts those files and
the first sync proposes Linear's form in its pull request.

### The confirmed run's summary

The summary is headed **Initial sync from git to Linear**. Its first line
says how the run ended: Linear equals the tracked branch and the state is
recorded; or the run stopped and needs another run; or a state ref moved
under it; or a container is over its cap and nothing was written. Then it
counts the documents it created, overwrote, left as they were, skipped (a
resumed run only), moved to trash and left out. Its tables:

| Table | What it means |
| --- | --- |
| Failed | A write Linear failed or rejected: the path, the operation and the error, never content. Shown only when there is one. |
| Moved to trash | The paths whose documents went to Linear's trash. Shown only when there is one. |
| Left out | As in the dry run, plus the files left out while writing. Shown only when there is one. |
| Container document capacity | As in the dry run. |

A run that stopped also says why (for example `Stopped: rate limited, retry
after 120 s`) and how many items it did not write yet.

### The report file

With `report-file` set, the run writes its report as JSON (names, paths and
states, never content) and the job summary beside it as `summary.md`. Its
`summary.plan` lists the paths to create, overwrite and move to trash,
`summary.leftOutFiles` the left-out files with their rules, and
`initialSync` the confirmed run's outcome. A workflow can upload both as an
artifact.

## A run that stops

A large repository needs more than one run. Linear's rate limit stops a run
before it runs out (`stopped`), and the job's time limit of 55 minutes, set
by the GitHub App token's one-hour lifetime, ends one. When Linear fails or
rejects a write, the run writes the rest but trashes nothing
(`write-failed`). A state ref that another run moves under it ends it too
(`state-moved`). Such a run exits with code 5 (a run the time limit ends
just stops) and does not record `linear`. The documents it wrote are in
`ids` up to its last push; after `state-moved` or a cancelled job, the
next run finds the rest by their titles.

Run it again with the same inputs, after the reset time in the summary when
it was rate limited. It plans again, skips the documents an earlier run
wrote, finds a document created just before a crash by its title instead
of creating it twice, and records `linear` once everything is written.
Until then every sync run writes nothing and stops with
`initial-sync-required` and exit code 4.

The other ends and what to do about each are in
[troubleshooting.md](troubleshooting.md#initial-sync). A confirmed run also
waits, with `initial-pull-request-pending` and exit code 4, while the sync
branch holds an initial sync from Linear that is not merged: merge its pull
request, or close it **and delete its branch** (`mdbisync/linear` by
default), first. Closing the pull request alone is not enough
([starting over](initial-sync-linear-to-git.md#starting-over-instead-of-merging)).

## After the initial sync

1. Check a few documents in Linear: their text, images and links.
2. Enable the sync workflow. Its first run finds nothing to write, or opens
   a pull request with Linear's form of the files Linear reformatted.
3. Fix the files left out, in git; the sync takes each in once it passes.

From then on the sync keeps both sides equal; what happens when both sides
change one document is in [conflicts.md](conflicts.md).

## Recovery

Run the initial sync again when the sync refuses with
`initial-sync-required`, when its state refs are lost, or when you no longer
trust them: disable the sync workflow, run the dry run, then the confirmed
run. It matches documents by title again, so it rebuilds `ids` without
creating duplicates, writes only the documents whose text differs from the
tracked branch, and replaces the state refs. When to recover, and which
lost state the sync rebuilds without it, is in
[troubleshooting.md](troubleshooting.md#recovery-with-initial-sync).

To undo an initial sync from git to Linear, restore the trashed documents
from Linear's trash. The sync keeps no copy of the text it overwrote, so
read the dry run's **Overwrite** table before you confirm.
