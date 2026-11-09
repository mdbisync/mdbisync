# Initial sync from Linear to git

The initial sync with `direction: linear-to-git` takes the documents your
team keeps in Linear into git. Linear is the model: one pull request makes
the synchronized folders of the tracked branch (`main` by default) equal to
Linear. Nothing in Linear changes, not even a title.

> **It can remove files.** A synchronized file that has no document in
> Linear is removed by the pull request. The sync never merges that pull
> request: a person reviews it and merges it, as described in
> [step 3](#step-3-a-person-reviews-and-merges-the-pull-request). Until then
> nothing changes on the tracked branch, and removed files stay in its
> history after the merge.

How to set up the repository is in the [README](../README.md); how folders
map to Linear and what every run checks is in [usage.md](usage.md).

## When to use it

- Your documents live in Linear and you want to keep them in git from now
  on, with the sync keeping both sides equal afterwards.
- The sync's state was lost, or git and Linear drifted apart, and Linear
  holds the version you trust.

When git holds the version to keep, use `direction: git-to-linear` instead
([usage.md](usage.md#initial-sync-from-git-to-linear)): it makes Linear equal
to git and moves Linear-only documents to Linear's trash.

## Before you start

- Finish the setup and map each folder to its Linear team or project in the
  front matter of its `README.md`
  ([folder mapping](usage.md#folder-mapping)).
- In the repository settings, turn on **Allow merge commits**.
- Disable the sync workflow (Actions → *mdbisync* → **⋯** → **Disable
  workflow**),
  and keep it disabled until the pull request is merged. Both workflows share
  one queue, and a sync queued behind a running one can replace a waiting
  initial sync.

## Step 1: dry run

Run the initial sync workflow from the Actions tab with `direction:
linear-to-git` and **confirm** unchecked. It writes nothing to git or Linear.
Its job summary lists, by path and never with document content:

| Table | What it means |
| --- | --- |
| Overwrite | A file whose path a document's title names. It will get the document's text; its front matter stays. |
| Create | A document without a file. It will become a new file at the path its title names. |
| Remove | A synchronized file without a document. The pull request will remove it. |
| Kept | A folder's annotation `README.md` without a document. It stays, since the folder's mapping depends on it. Shown only when there is one. |
| Left out | A file or document the run cannot take, with the rule that stops it. |

Read the **Remove** table carefully. If a file there should stay, create its
document in Linear, titled with the file's path below its mapped folder
without `.md`, and run the dry run again.

## Step 2: confirmed run

Run the workflow again with the same direction and **confirm** checked.

What it writes to git:

- matched files get their document's text, keeping their front matter;
  documents without a file become new files; synchronized files without a
  document are removed, except annotation `README.md` files;
- images and other files a document embeds from Linear are downloaded next to
  it, named by their content's SHA-256 hash (`<hash>.png`), and linked
  relatively. A file the branch already holds with the same content is linked
  instead of copied. The repository's `.gitattributes` decides whether a file
  goes to Git LFS, as for a person's commit. The sync records where each file
  came from, so it never uploads it to Linear again;
- a link to another synchronized document's Linear URL becomes a relative
  link to that document's file;
- state refs (under `refs/mdbisync/` by default) that tie each file to its
  document, and
  the sync branch (`mdbisync/linear` by default) with one commit on top of the
  tracked branch;
- a pull request titled **Initial sync from Linear** from the sync branch to
  the tracked branch. Its description counts the files it overwrites,
  creates and removes, and lists the first 100 removed files.

When the repository has security hooks (marked `alias: security`), they
check each document's text with the files it embeds before anything is
pushed. Without them, Linear's content reaches git unchecked, and the run's
summary says so.

### File names for titles

A document's title is its path below the mapped folder: the document
`guides/install` in a project mapped to `notes/` becomes
`notes/guides/install.md`. Characters a file name cannot hold are
percent-encoded (`Q3: plans?` becomes `Q3%3A plans%3F.md`), and a name that
would land on another file gets a short suffix made from the document's id.
The title in Linear stays as it is. The full rule, the same one the sync uses
afterwards, is in [usage.md](usage.md#file-names-for-titles).

### What is left out

The job summary's **Left out** table names each file or document the run did
not take, and why.

The dry run already leaves out the files the sync cannot keep in Linear's
form: those with a finding of the `linear-format` linter (its rules are in
[linear-format.md](linear-format.md)), a title that collides with another
file's or is too long, or a file git does not store as text (in LFS,
binary). Such a file stays in git as it is, and the document whose title
names it is not taken.

The confirmed run can leave out more once it has each document's text, for
the rules below. A new file is left out of the pull request; an existing
file keeps the tracked branch's text and stays tied to its document.

| Rule | Why |
| --- | --- |
| `download-failed` | A file the document embeds could not be downloaded (gone, over 10 MB, or redirected elsewhere). |
| `front-matter-boundary` | The document's text starts with something that reads as front matter, so it would not stay the file's body. |
| `title-not-a-path` | The new file would map back to another document or another folder's team or project. |
| `security-hook` | A security hook reported a finding in the document's text or its files. |
| `security-unchecked` | The security hooks have not seen this text, for example because their step did not run. |

### A run that stops

A run that stops early (Linear's rate limit, another run moving the state)
exits with code 5; a run the job's time limit ends just stops. Run it again
with the same inputs: it skips the documents an earlier run recorded and
creates no duplicate files.
If the pull request could not be opened, running again opens it.

## Step 3: a person reviews and merges the pull request

The pull request waits for a person, because it can remove files. The sync
does not merge it and does not add to it.

1. Open the pull request **Initial sync from Linear**; the job summary of the
   confirmed run gives its number.
2. Read the **Removed files** list in its description, which shows the
   first 100, and the *Files changed* tab, which shows all of them. Each
   removed file had no document in Linear.
3. To keep a file the pull request removes, either create its document in
   Linear and run the confirmed initial sync again (the open pull request
   then shows the new result and its description is rewritten), or merge
   first and restore the file from history in an ordinary commit; the sync
   then creates its document in Linear.
4. Merge with **Create a merge commit**, not with squash or rebase. The pull
   request's head commit is the starting point the sync compares both sides
   against.
5. Enable the sync workflow again.

Until the merge, every sync run writes nothing and stops with exit code 4
and `initial-pull-request-pending`, and a confirmed initial sync from git to
Linear waits too. After the merge, when the confirmed run left nothing out,
the first sync finds nothing to write: it changes no document in Linear and
opens no pull request. Documents the run left out are read again by the
sync, which brings them in through an ordinary sync pull request. An annotation `README.md`
that was kept without a document becomes a document once you edit its body
in git.

## Starting over instead of merging

If Linear changed after the confirmed run, run it again with the same
inputs: it moves the open pull request to the new result. If git and Linear
are already equal, a new run closes the pull request because it has nothing
left to carry.

To abandon the pull request:

1. Keep the sync workflow disabled for all of the following steps.
2. Close the pull request and delete its branch (`mdbisync/linear` by
   default).
3. Run a new initial sync, in either direction. For `linear-to-git`, its new
   pull request goes through step 3 again.
4. Enable the sync workflow only when that initial sync is in place.

Do not let the sync run between deleting the branch and the new initial
sync.

If a person pushed commits to the pull request's branch, a new confirmed run
leaves them alone and stops: merge or close the pull request and delete the
branch first.
