# How the sync works

After the initial sync, the sync workflow keeps git and Linear equal: an
edit made on either side reaches the other side by itself. This page follows
one run step by step, shows how a change travels each way, what people see
in GitHub and in Linear, how long it takes, and what every line of a run's
summary means.

In this page, "git" means the tracked branch (`main` by default), "the sync
pull request" is the one pull request the sync opens and merges itself, and
"the run summary" is the summary of a sync workflow run in the Actions tab.
How to set up the workflows, the folder mapping and the setup check are in
[usage.md](usage.md); what happens when both sides change the same document
is in [conflicts.md](conflicts.md).

## One run

The sync workflow runs on every push to the tracked branch, every five
minutes, and by hand ([workflows](usage.md#workflows)). Runs of one
repository never overlap. Each run makes these steps, in this order:

0. **Setup check.** The run checks its tokens, the repository settings and
   the folder annotations, and stops before any write when one fails
   ([setup check](usage.md#setup-check)).
1. **Capture.** The run reads the documents that changed in Linear since the
   last capture, turns them into files, runs the repository's security
   hooks on them, and commits the files that pass to the sync's own record
   of Linear, the ref `refs/mdbisync/linear`. A document that fails a hook
   is not committed and gets the [blocked mark](#the-blocked-mark).
2. **Linear to git.** When Linear's record holds something the tracked
   branch lacks, the run opens the sync pull request, or adds the new
   changes to the open one, and merges it once its checks pass
   ([the sync pull request](usage.md#the-sync-pull-request)).
3. **Git to Linear, computed.** The run merges the tracked branch into
   Linear's record in its own working copy, with git's three-way merge.
   Nothing is pushed yet.
4. **Write.** For each document where the merge result differs from what
   Linear holds, the run reads the document again. If nobody changed it
   since step 1, the run writes the new text, renames or moves it, creates
   or trashes it. A document someone edited in the meantime is skipped this
   run.
5. **Record.** The run reads back what it wrote and commits Linear's answer
   to `refs/mdbisync/linear`, so the next run starts from what Linear
   really holds.

The sync's state lives in three refs under `refs/mdbisync/` (Linear's
record, the map of files to Linear document ids, and the cache of uploaded
images) and in the sync branch `mdbisync/linear`. A plain clone does not
fetch the refs, and the sync writes nothing of its own into your files.

## A change made in Linear

1. Someone edits, creates, renames, moves, trashes or restores a document
   in a synchronized team or project.
2. The next run captures it (step 1): the text becomes the file's new text,
   with the file's front matter kept from git; a new title moves the file
   (one rule turns titles into file names, see
   [file names for titles](usage.md#file-names-for-titles)); a move to
   another project moves the file to that project's folder; a trashed
   document, or one moved out of the synchronized projects, removes the
   file; a restored one brings it back. Images and files the document
   embeds from Linear are downloaded next to it.
3. The same run takes the change towards git (step 2): it opens the sync
   pull request **Changes from Linear**, or adds the change to the open
   one, and waits a short grace period for its checks.
4. When every check on the pull request's head has passed, the sync merges
   it with a merge commit. The tracked branch now holds the change.
5. That merge is a push to the tracked branch, so it starts another run.
   That run finds Linear and git equal and writes nothing.

An edit to a document's icon, color or comments changes no file and makes
no commit.

## A change made in git

1. Someone merges a change to a synchronized file into the tracked branch,
   through a pull request or a push.
2. The push starts a run. Steps 3 to 5 write the change to Linear: a new
   text updates the document in place (Linear applies only the difference,
   so its comments and history stay); a renamed or moved file renames the
   document or moves it to another project or team, as git's rename
   detection finds it; a new or copied file creates a document; a removed
   file moves its document to Linear's trash, from which it can be
   restored. Images the file links are uploaded once and reused.
3. The run records what Linear returned and opens no pull request: the
   tracked branch already holds the change.

A file Linear cannot hold as it is, such as Markdown that Linear would
change or lose ([linear-format.md](linear-format.md)), or an image over
Linear's upload limit, is left out: it stays in git, and the run summary
lists it under **Left out** with the rule that stopped it, until it is
fixed.

When both sides changed the same document between two runs, git merges the
two edits. Edits of different paragraphs both arrive on both sides; edits
of the same lines become a conflict, written into the document on both
sides ([conflicts.md](conflicts.md)).

## What people see

### In GitHub

- **One sync pull request** at a time, titled **Changes from Linear**, from
  the branch `mdbisync/linear` to the tracked branch. It is opened, updated
  and merged by the sync's GitHub App (`<your app>[bot]`), so your
  repository's CI runs on it like on any other pull request. Its
  description lists the files it changes, by path.
- **Merge commits** on the tracked branch, made by the App, one for each
  merged sync pull request. The repository must allow merge commits.
- The branch `mdbisync/linear` is never force-pushed. Commits a person or a
  CI job adds to it are kept and go to the tracked branch with the pull
  request; closing the pull request does not drop them, and the next run
  opens a replacement from the same branch.
- Nothing else: the sync never pushes to the tracked branch directly.

### In Linear

- Documents change only where git changed them. The sync writes through
  your Linear OAuth app, so its edits come from the app, not from a person.
- A document's icon and color are its owner's. The sync changes them in two
  cases only, and puts the owner's back exactly when the case clears:

  | Mark | Meaning | Who acts |
  | --- | --- | --- |
  | Red `Cross` | **Blocked**: a security hook rejected the document, so it is not synchronized | its author, by fixing the finding in Linear |
  | Orange `Alert` | **Conflict**: the document holds both versions between conflict markers | anyone, on either side ([conflicts.md](conflicts.md)) |

### The blocked mark

When a repository security hook (a hook marked `alias: security`, see
[workflows](usage.md#workflows)) rejects a document's new text in step 1:

- the text is not committed anywhere: not to the sync's refs, the sync
  branch, the sync pull request or the logs. The file in git keeps its last
  synchronized text;
- the document's icon becomes the red `Cross`; its own icon and color are
  saved by the sync;
- the sync adds one comment, which names the hook and the line, never what
  it found:

  > Security checks rejected this document. Fix the listed findings and
  > sync again.
  >
  > - Hook `gitleaks`, line 12.

  When the findings change, the same comment is edited to the new list.

Fix it by editing the document in Linear. The next run checks the new text;
when the hooks pass, it synchronizes the document and puts its own icon and
color back. The blocked mark takes precedence over the conflict mark, and
both share the one saved icon and color.

Without any security hook, the sync pushes Linear's content unchecked, and
every run summary says so.

## How long it takes

- **Git to Linear:** a push to the tracked branch starts a run at once, so
  the change is in Linear when that run finishes, usually within a minute
  or two. If another run is going, the new one waits for it.
- **Linear to git:** the next scheduled run captures the edit. GitHub
  schedules every five minutes at best and often starts them late, so
  expect five to fifteen minutes. The same run merges the sync pull request
  when its checks pass within the grace period (`merge-grace-seconds`,
  default 60 seconds); slower checks leave the merge to a later run, adding
  another schedule interval. Run the workflow by hand to take a Linear edit
  in sooner.
- **A conflict** changes nothing here: both versions arrive on both sides
  in the same runs that would have carried either edit.
- **A failing check** on the sync pull request stops both directions until
  it passes (see [Linear to the tracked branch](#linear-to-the-tracked-branch)).

## The run summary

Each run writes its summary to the Actions tab. It names paths, rules,
counts and states, never document content. It starts with the setup check
([setup check](usage.md#setup-check)) and goes on with a **Sync** section
in the order of the steps. A section a run did not reach is missing.

### Capture

The first line of the **Sync** section counts what the capture took from
Linear:

> Captured 3 files; removed 1; blocked 0; left out 0.

*Captured* files were changed, created, renamed or restored in Linear;
*removed* files were trashed or moved out of the synchronized projects;
*blocked* documents got the [blocked mark](#the-blocked-mark); *left out*
documents were not taken this run. Further lines appear when they apply:

| Message | What it means |
| --- | --- |
| Removal held for N files | Linear did not return these documents, while their place listed no document at all, as a blank answer from Linear would read. The files stay; the next run removes them if Linear still does not have them. The run is partial (`removal-held`). |
| The document id map was lost | The map of files to document ids was missing and was rebuilt by matching titles to paths. A document renamed in Linear since the last run comes back as a new file next to its old one. |
| Capture partial, will continue | Linear stopped the run (a rate limit) or failed a request. What was captured is kept, and the next run goes on from there. |
| Content is pushed unchecked | The repository has no security hooks. |
| `linear-content-too-large-to-write-back` | A document is longer than Linear accepts in a write. It is kept in git, but if it is changed in git while still over the limit, Linear will not take the change. |
| Capture did not finish; no tracked-branch changes were written. | The run stopped in the capture, before steps 2 to 5. |

A captured document can be left out with the rule `capture-translation`
(the run could not turn it into a file, for example an embedded file it
could not download) or `security-unchecked` (the security hooks have not
seen its current text; the next run checks it).

### Linear to the tracked branch

What step 2 did with the sync pull request, in one of these messages:

| Message | What it means |
| --- | --- |
| Merged the sync pull request with a merge commit | Every check on its head passed. |
| The tracked branch already holds every change from Linear | No pull request is needed. |
| Opened the sync pull request | Opened this run; it names the checks it is waiting for, and a later run merges it if they did not pass within the grace period. |
| Added new Linear changes to the sync pull request | New captures joined the open pull request. |
| The sync pull request waits for its checks | Nothing new; its checks are still running, and a later run merges it. |
| Setup error: a check failed on the sync pull request (`check-failed`) | The repository's checks reject Linear's form. Nothing is merged and nothing is written to Linear until they pass: fix the configuration or rerun the check. |
| Linear's latest changes and the tracked branch change the same lines (`conflict`) | The sync branch stays as it is this run. Conflicting documents get conflict markers; a conflicting file that is not a document waits for a person to merge it on the sync branch. |
| GitHub did not merge the sync pull request (`merge-refused`) | GitHub refused the merge once, with the reason it gave; a later run tries again. |
| Setup error: GitHub refused again to merge (`merge-blocked`) | The same refusal on the same head. Let the sync's App merge into the tracked branch (for example, adjust the branch's rules). |
| The sync branch holds an initial sync from Linear (`initial-pull-request-pending`) | A person has not merged the [initial sync from Linear](initial-sync-linear-to-git.md) yet; the sync adds nothing and writes nothing until then. |
| The sync branch moved while this run worked (`state-moved`) | Another writer moved the branch; the next run updates the pull request. |
| A request to GitHub failed or got no answer (`github-failed`) | The next run tries again. |

When they apply, it also counts the files the pull request changes and
names the documents where pending edits on the sync branch met later edits
(kept between conflict markers) or were decided by the conflict rules.

### Tracked branch to Linear

What steps 3 to 5 did. "Linear already holds the tracked branch: nothing to
write." when there was nothing to do; otherwise one outcome:

| Outcome | What it means |
| --- | --- |
| Linear now holds the tracked branch. | Every change was written and recorded. |
| Some documents were not written; the next run writes them. | Some were skipped, failed or left out; the rest were written and recorded. |
| A state ref moved while this run was writing | Another run moved the sync's refs; this one recorded nothing, and the next run writes again what is still missing. |
| Nothing was written. (`container-cap`) | A Linear team or project would go over its document cap ([capacity](usage.md#initial-sync-from-git-to-linear)); make room or raise `document-cap`. |

followed by the counts: documents written with the file's new text, renamed
or moved, created, restored (Linear had removed them while git changed
them), with conflict markers, moved to Linear's trash, skipped, and files
left out. Then the tables, each shown only when it has rows:

| Table | What it lists |
| --- | --- |
| Failed | Writes Linear refused or failed, with the operation and the error. The next run tries again. |
| Skipped | Documents not written this run, with why. |
| Conflict markers | Documents this run wrote with conflict markers ([conflicts.md](conflicts.md)). |
| Decided by the conflict rules | Deletes and renames that met an edit or another rename, with the rule that decided them ([deletes and renames](conflicts.md#deletes-and-renames)). |
| Renamed or moved | Documents renamed or moved, from and to. |
| Moved to trash | Documents whose files were removed in git. |
| Left out | Files that stay in git only, with the rules that stop them ([linear-format.md](linear-format.md)). |

A skipped document has one of these reasons:

| Reason | What it means |
| --- | --- |
| `edited-in-linear` | Changed in Linear since it was read; the next run takes that change in and writes again. |
| `missing-in-linear` | Not found in Linear, or in its trash; the next run takes that in. |
| `conflict` | Changed on both sides in a way git cannot merge; it is written when the conflict is resolved. |
| `renamed-to-unwritable` | Its file was renamed to one that is in conflict or left out; the document stays as it is until that is fixed. |

When the run stopped part way, the section says why (for example Linear's
rate limit, with its rate-limit headers) and how many items are not written
yet. A section on **Container document capacity** follows when a team or
project is at 90% of its document cap or more.

### How a run ends

| Run | Job status | Exit code | Last message |
| --- | --- | --- | --- |
| Finished, or nothing to do | success | 0 | |
| Partial: Linear stopped it, a request or write failed, a state ref moved, or a removal is held | warning | 5 | `sync: partial, will continue (<code>)` |
| A failed check on the sync pull request, or a merge GitHub refuses again | failure | 3 | `sync: setup error (<code>): …` |
| The sync branch moved, or a request to GitHub failed, in step 2 | failure | 5 | `sync: not finished (<code>); run it again` |
| The setup check failed | failure | 3 | `sync: stopped before any write (<code>): …` |
| No initial sync yet (`initial-sync-required`), or its pull request waits for a person | failure | 4 | `sync: stopped before any write (<code>)` or `sync: stopped short (initial-pull-request-pending): …` |
| A team or project over its document cap | failure | 5 | `sync: stopped before any write (container-cap); …` |

A partial run is not a failure: it kept what it could record, and the next
scheduled run goes on from there. The `<code>` is one of `stopped`,
`linear-failed`, `write-failed`, `state-moved` or `removal-held`. The exit
code is the command line's; in the action the job status says the same.
