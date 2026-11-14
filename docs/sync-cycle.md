# How the sync works

After the initial sync (from [git to Linear](initial-sync-git-to-linear.md)
or from [Linear to git](initial-sync-linear-to-git.md)), the sync workflow
keeps git and Linear equal: an edit made on either side reaches the other
side by itself. This page follows one run step by step, shows how a change
travels each way, what people see in GitHub and in Linear, how long it
takes, and what every line of a run's summary means.

In this page, "git" means the tracked branch (`main` by default), "the sync
pull request" is the normal pull request the sync opens and merges itself, and
"the run summary" is the summary of a sync workflow run in the Actions tab.
How to set up the workflows, the folder mapping and the setup check are in
[usage.md](usage.md); what happens when both sides change the same document
is in [conflicts.md](conflicts.md), and what to do about each code and
warning is in [troubleshooting.md](troubleshooting.md).

## One run

The sync workflow runs on every push to the tracked branch, every five
minutes, and by hand ([workflows](usage.md#workflows)). Runs of one
repository share a concurrency group in the supplied workflows
([overlapping runs](#overlapping-runs)). Each run makes these steps, in this order:

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
   changes to the open one, and merges it once its checks pass. A failed
   batch moves to the suspended lane; a red tracked branch holds it, and
   pending suspended checks take priority
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
images) and in the normal branch `mdbisync/linear` and the suspended branch
`mdbisync/suspended`, created when first needed. The suspended branch can
stay after release unless GitHub automatically deletes merged branches.
A plain clone does not
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

## Editing while sync runs

Keep editing in Linear and pushing or merging into the tracked branch while
ongoing sync runs. You do not need to wait for a run to finish:

- Changes on both sides use the three-way merge described above. Different
  paragraphs merge; competing changes to the same paragraph keep both
  versions with [conflict markers](conflicts.md).
- If an already tracked document changes in Linear between capture and its
  final re-read, the run skips that document. The next run captures the newer text and
  tries again; other documents keep syncing.
- A run that stops after creating a document but before recording its id
  leaves the document in Linear. If you edit that document, nothing
  overwrites your edit: a later run takes the document over only if it
  still holds the text the run would write. Otherwise the next run captures
  it as a new document at the file's path. The two texts have no earlier
  version in common, so every part where the document and the file in git
  differ becomes a [conflict](conflicts.md) that keeps both versions.
- A push that arrives after the run read the tracked branch is picked up by
  a later run. Commits on the sync branch are kept too, including changes
  from a person or CI. Closing its pull request causes a later run to open
  a replacement from the same branch.

There is a remaining race: Linear's document writes accept no version
condition. An edit made after the final re-read but before the write lands
can be lost. The run's `rereadWindowMs` measurement in the JSON report
([`report-file`](configuration.md#action-inputs)) is the largest interval from
receipt of a batch re-read's answer to receipt of a successful write's answer. It
includes earlier writes in that batch and retries. It excludes the time
between Linear reading the document and the client receiving that response,
so it does not bound the entire race or establish a fixed safe interval.

In a live race test, the run was deliberately paused after the re-read
while 100 edit markers were written. The test harness measured a held interval
of **82,077 ms** (82.077 seconds), and all 100 markers were lost. An earlier live test held
the interval for 88,471 ms and also lost 100 markers. These artificial
pauses demonstrate the risk; they are not normal write latency. Tests with
a local fake service and no pause measured 4.4–12.9 ms across six runs;
those timings do not measure live Linear latency.

Separate live checks kept three edits to different paragraphs from two
Linear editors and git. A burst targeting 15 minutes generated 750 Linear
edits and 15 git pushes: after editing stopped and sync settled, all 765
edit markers were present in both git and Linear, with no lost marker and
no content difference. These results show convergence for those runs;
they do not remove the re-read-to-write race or establish a sustained-load
limit. For a critical edit where that residual risk is unacceptable, stop
ongoing sync, wait for the active run to finish, edit, then enable it again.

## Overlapping runs

The supplied sync and initial-sync workflows use the same repository-scoped
group, `concurrency: { group: mdbisync, cancel-in-progress: false }`.
Keep that shared group when adapting the workflows. GitHub allows one
running and one pending run in the group: a new arrival replaces an older
pending run, and does not cancel the running one. This is not a FIFO queue
that executes every trigger. A later ongoing-sync run reads the current
state, so replacing a pending trigger does not discard the edits it would
have read. A live check using pushes and manual dispatches standing in for
scheduled runs observed at most one active run, at least one replaced pending run, and all edits
preserved.

The group serializes these workflows in one repository. It does not lock
Linear editors, another repository, or a CLI run outside Actions. State-ref
pushes also use atomic updates with leases: if another writer moved a ref,
the push is refused rather than partly overwriting state. The next run
can read the newer state and retry; this does not close the Linear write
race above. Avoid running an independent writer against the same documents.

Before initial sync or recovery, disable the ongoing-sync workflow, stop
your own dispatch timer if you run one, and wait for its active run to
finish. Otherwise a newly queued ongoing-sync run can replace the pending
initial-sync run. Follow the initial-sync direction's instructions before
confirming its writes.

## What people see

### In GitHub

- **One normal sync pull request** at a time, titled **Changes from Linear**, from
  the branch `mdbisync/linear` to the tracked branch. It is opened, updated
  and merged by the sync's GitHub App (`<your app>[bot]`), so your
  repository's CI runs on it like on any other pull request. Its
  description lists the files it changes, by path. A second pull request,
  **Suspended changes from Linear** from `mdbisync/suspended`, holds failing
  batches until they pass ([suspension and release](#suspension-and-release)).
- **Merge commits** on the tracked branch, made by the App, one for each
  merged sync pull request. The repository must allow merge commits.
- The commits the sync makes itself, on the sync branch and its refs, have
  the App's bot account (`<your app>[bot]`) as author and committer, with
  the address GitHub links to the App, so GitHub shows them as the App's.
  They have fixed messages such as `Capture Linear changes`, name no person
  and quote no content. A commit a CI job adds to the sync branch keeps the
  name that job gives it.
- The branch `mdbisync/linear` is never force-pushed. Commits a person or a
  CI job adds to it are kept and go to the tracked branch with the pull
  request; closing the pull request does not drop them, and the next run
  opens a replacement from the same branch.
- Nothing else: the sync never pushes to the tracked branch directly.

### In Linear

- Documents change only where git changed them. The sync writes through
  your Linear OAuth app, so its edits come from the app, not from a person.
- A document's icon and color are its owner's. The sync changes them in three
  cases, and puts the owner's back exactly when the case clears:

  | Mark | Meaning | Who acts |
  | --- | --- | --- |
  | Red `Cross` | **Blocked**: a security hook rejected the document, so it is not synchronized | its author, by fixing the finding in Linear |
  | Red `Cross` | **Suspended**: a check failed or did not finish in time on the batch's pull request | fix the document in Linear or fix CI in git |
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
color back. The marks take precedence in this order: blocked, suspended, conflict.
All share the one saved icon and color; clearing one still leaves any
other applicable mark.

Without any security hook, the sync pushes Linear's content unchecked, and
every run summary says so.

## Suspension and release

A failed pull request check suspends its whole batch, even if only one
file caused it. Checks GitHub reports as pending or queued past
`check-deadline-minutes` (default 60, range 10–1440) count as failed too.
This deadline starts at the head's push, recorded in a hidden HTML note
in the pull request description; it is separate from the short merge
grace period. A new head starts a new deadline. The sync never reruns a
check. Configure flaky-check retries in the repository's CI; a rerun by a
person or CI counts by its latest result. No Actions permission is needed.
The deadline covers only checks GitHub has registered on the head. The
sync does not read the branch's list of required checks: branch
protection's list needs an App permission the sync does not ask for
(only rulesets are readable without it), and a required check that never
registers is a repository setting, not a fault of the batch's documents.
The sync expects, besides the checks registered on a head, every check
registered on the pull request's earlier heads and every name in
`required-checks`, and it merges no head with no checks at all unless
`merge-without-checks` is `true`. A head that lacks an expected check, or
has none, waits; past the deadline the run reports the setup error
`checks-missing`, and nothing is suspended or marked in Linear. A check
only GitHub's branch rules require lets the sync try the merge: if GitHub
refuses it, the run reports `merge-refused`; a later run that meets the
same refusal on the same head, with the tracked branch unmoved, reports
the setup error `merge-blocked`. Nothing is suspended or marked in Linear.
Check workflow filters and the required-check names if this happens.

The batch joins the one **Suspended changes from Linear** pull request.
The normal branch records `Set aside suspended changes` and its pull
request closes once GitHub shows the empty set-aside head. The sync waits
up to five seconds for that update, then leaves closure to a later run if
necessary. New normal batches and suspended release wait for that close;
later changes to other documents then use the normal lane.
Security hooks still run before any push and keep their separate blocked
mark. Suspension is a successful run, not a setup error.

Each suspended document shows a red `Cross` and one comment, for example:

> Changes to this document are on hold: a check failed on the pull request that brings them to Git. Other documents keep syncing.
>
> - Check `build`: [run](https://github.com/example/handbook/actions/runs/123)
>   - Line 12: Unsupported heading.
>
> The failure may come from another document of the same change. If a line above names this document, edit it here to try again; the hold also clears when the check is fixed in Git.

For a timeout the opening is:

> Changes to this document are on hold: a check did not finish in time on the pull request that brings them to Git. Other documents keep syncing.

and its check line says:

> - Check `build` did not finish in time.

Only annotations on this document's path are quoted: at most ten per
check, each shortened to 200 characters. Text that repeats document
content is omitted; raw CI logs are never copied. When the failure
changes, the same comment is edited. At most 50 documents have their
suspended mark or comment changed per run; the rest follow in later runs.
Documents in Linear's trash or archived have no mark.

A suspended document is frozen both ways: later Linear edits go only to
the suspended pull request, and tracked-branch edits are not written to
that document in Linear. Edit the document in Linear to fix an annotated
problem, or fix CI on the tracked branch. Either change updates the
suspended lane and its new head gets checks. Once the suspended head
contains the current tracked tip and its checks pass, the sync merges it,
resolves the comments and clears the suspended marks. Linear refuses to
resolve a comment on a document in its trash: such a comment stays open,
and the run summary names the document once. Any remaining
blocked or conflict mark still applies. The normal three-way merge
resumes using the recorded base, so changes waiting on either side meet
without dropping an edit; overlapping edits can still create a conflict.

The suspended lane goes first: while its head's checks are pending before
the deadline, the normal lane may collect changes but cannot merge. A
failed or timed-out suspended head lets the normal lane proceed.

### When the tracked branch is red

If the same check also fails on the tracked branch's tip (`main` by
default), the normal pull request is held open instead of suspending its
batch. No document gets a mark or comment for this failure, and no alert
is written to Linear. Git-to-Linear writes continue for documents that
are not suspended. The run summary names the check and links to its run
on the tracked tip. A hidden HTML note in the normal pull request's
description records the hold.

If the check still runs on the tracked tip, the initial decision waits
up to the deadline. An already recorded red-main hold waits until the
held checks have actually run and passed on that tip. When they pass,
the sync merges a new tracked tip into the normal branch and checks the
new head. If the held head already contains that tip and still fails,
it is suspended: the sync does not restart CI for an unchanged head.
Existing suspended documents keep their comments unchanged while the
same check also fails on the tracked tip.

## How long it takes

- **Git to Linear:** a push to the tracked branch starts a run at once, so
  the change is in Linear when that run finishes, usually within a minute
  or two. If another run is going, the new one waits for it.
- **Linear to git:** the next run captures the edit. Between pushes that
  is a run from your own timer, GitHub's schedule or a run by hand. With
  a timer that is within its interval plus the run
  ([own scheduler](own-scheduler.md)); GitHub's schedule alone can take
  hours, since GitHub may start scheduled runs late or skip them. The
  same run merges the sync pull request when its checks pass within the
  grace period (`merge-grace-seconds`, default 60 seconds); slower checks
  leave the merge to a later run, one more interval. Run the workflow by
  hand to take a Linear edit in sooner.
- **A conflict** adds no delay: both versions arrive on both sides in the
  same runs that would have carried either edit.
- **A failing check** moves the batch to **Suspended changes from Linear**
  on `mdbisync/suspended`. Other documents keep syncing. Suspended documents
  are frozen until the suspended pull request passes its checks and merges.
  Later Linear edits go only to that lane; tracked-branch edits wait for release.

## The run summary

Each run writes a job summary in the Actions tab. It names paths, rules,
counts and states, never document content. It starts with the setup check
([setup check](usage.md#setup-check)) and goes on with a **Sync** section
in the order of the steps; a part the run did not reach is missing. The run
ends with a last line and, for the command line, an exit code. Every code,
warning and last line, with what to do about it, is in
[troubleshooting.md](troubleshooting.md); this section shows what an
ordinary run says.

### Capture

The first line counts what step 1 took from Linear:

> Captured 3 files; removed 1; blocked 0; left out 0.

*Captured* files were changed, created, renamed, moved or restored in
Linear; *removed* paths are files whose documents were trashed in Linear or
moved out of the synchronized projects, and the old paths of documents
renamed or moved in Linear (a rename counts once as captured and once as
removed); *blocked* documents got the
[blocked mark](#the-blocked-mark); *left out* documents were not taken this
run (`capture-translation`, `download-retry` or `security-unchecked`,
[files left out](troubleshooting.md#files-left-out)). Lines that follow
only when they apply:

| Line | Where it is explained |
| --- | --- |
| `download-retry: "<document id>"` | [Files left out](troubleshooting.md#files-left-out); an upload download failed temporarily and the next run retries it without marking the document. |
| Removal held for N files | [`removal-held`](troubleshooting.md#partial-sync-runs) |
| The document id map was lost | [Recovery with initial sync](troubleshooting.md#recovery-with-initial-sync) |
| Capture partial, will continue | [`stopped` and `linear-failed`](troubleshooting.md#partial-sync-runs) |
| Content is pushed unchecked | [The blocked mark](#the-blocked-mark) and the `security-hooks` warning of the [setup check](troubleshooting.md#setup-check) |
| `linear-content-too-large-to-write-back` | [Other summary lines](troubleshooting.md#other-summary-lines) |
| Capture did not finish; no tracked-branch changes were written. | The run stopped in step 1. Either Linear stopped it or failed a request (the lines above say so), or another run moved the state refs while this one captured ([`state-moved`](troubleshooting.md#partial-sync-runs)). |

### Linear to the tracked branch

What step 2 did with the sync pull request. An ordinary run says one of:

| Line | What it means |
| --- | --- |
| Merged the sync pull request with a merge commit | Every check on its head passed; the tracked branch now holds Linear's changes. |
| The tracked branch already holds every change from Linear | No pull request is needed. |
| Opened the sync pull request | Opened this run. It names the checks still running at the end of the grace period; a later run merges it. |
| Added new Linear changes to the sync pull request | New captures joined the open pull request. |
| The sync pull request waits for its checks | Its checks are still running, and a later run merges it. |

An existing head with passing registered checks gets a merge attempt before
fresh captures join the branch. Captures remain on Linear's state ref for
the next batch; a successful merge can therefore leave newer changes pending.

The suspended lane and its marks add these lines when applicable:

| Line or beginning | What it means |
| --- | --- |
| Suspended changes | Links the suspended pull request and lists its paths. |
| The normal pull request is waiting for GitHub to show its empty head | A later run retries the close; new normal batches and suspended release wait for it. |
| Released the suspended batch. | Its head passed and merged; the freeze ends. |
| GitHub refused the suspended merge | A merge refusal on that lane; `merge-refused` and `merge-blocked` apply to either lane. |
| A GitHub request for the suspended lane failed; the normal lane still runs. | A later run retries that lane. |
| Suspended files waiting for a manual merge | Named non-document files could not be merged; see [troubleshooting](troubleshooting.md#the-sync-pull-request). |
| Failed checks: | Names the failed checks on the suspended head or joining batch. |
| Checks that did not finish in time: | Names checks reported as pending past the deadline. |
| The suspended documents' comments in Linear stay as they are: | The same check failed on the tracked tip; its failure must not rewrite document comments. |
| The suspended documents' comments in Linear wait: | A check failed on the suspended head but still runs on the tracked tip; the comments wait for that result. |
| Suspended documents in Linear: | Counts documents marked, comments updated and marks cleared. |
| more suspended documents get their mark or comment in a later run | Counts deferred documents, at most 50 changed per run. |
| Suspended documents in Linear's trash or archived, without a mark: | Lists documents that cannot receive a mark. |
| GitHub did not give the annotations of | Comments name those checks without annotations; a later run can retry. |
| The suspended marks did not finish | Gives the stopping code and, for a failed write, its operation, the document's path, the error's class, Linear's code and HTTP status, and Linear's message on one line; the report's `pullRequest.holdMarks.failure` also keeps Linear's request id. A message that repeats the comment the request sent is withheld. A later run goes on. |

A red tracked branch has a held-pull-request line naming and linking to
its failing checks. A line saying a check “failed on the sync pull request”
and “still runs on the tracked branch's tip” means the sync waits for that
result before suspending anything. A normal head waiting for the suspended
head says “it merges after the suspended pull request, whose checks still run.”

Any other line names a code (`conflict`, `merge-refused`,
`merge-blocked`, `initial-pull-request-pending`, `state-moved`,
`github-failed`), explained in
[the sync pull request](troubleshooting.md#the-sync-pull-request). The
section also counts the files the pull request changes, and names the
documents where pending edits on the sync branch met later edits
([conflicts.md](conflicts.md)).

### Tracked branch to Linear

What steps 3 to 5 did. A run with nothing to do says "Linear already holds
the tracked branch: nothing to write." Otherwise it gives one outcome:

| Outcome | What it means |
| --- | --- |
| Linear now holds the tracked branch. | Every change was written and recorded. |
| Some documents were not written; the next run writes them. | Some were skipped, failed or left out; the rest were written and recorded. |
| A state ref moved while this run was writing | [`state-moved`](troubleshooting.md#partial-sync-runs) |
| Nothing was written. | [`container-cap`](troubleshooting.md#container-cap) |

Then it counts the documents written with the file's new text, renamed or
moved, created, restored (Linear had removed them while git changed them),
written with conflict markers, moved to Linear's trash, skipped, and the
files left out. Tables follow, each only when it has rows:

| Table | What it lists |
| --- | --- |
| Failed | Writes Linear refused or failed, with the operation and the error ([`write-failed`](troubleshooting.md#partial-sync-runs)). |
| Skipped | Documents not written this run, with why ([skipped documents](troubleshooting.md#skipped-documents)). |
| Conflict markers | Documents this run wrote with conflict markers ([conflicts.md](conflicts.md)). |
| Decided by the conflict rules | Deletes and renames that met an edit or another rename ([the rules](troubleshooting.md#decided-by-the-conflict-rules)). |
| Renamed or moved | Documents renamed or moved, from and to. |
| Moved to trash | Documents whose files were removed in git. |
| Left out | Files that stay in git only, with their rules ([files left out](troubleshooting.md#files-left-out)). |
| CI fixes not written | Files left out before writing by format or mapping checks, with their CI fixing commit's hook ids and the rules that prevent writing them to Linear. |

The current pre-commit workflow records modifying hook ids in `Pre-commit-fix`
commit trailers. The summary lists the configured hooks on the latest commit
that changed each left-out file. A commit can contain fixes from several hooks;
the table lists those hooks together. Older workflows without these trailers
still deliver supported fixes and report left-out rules, without hook names.

When Linear stopped the run part way, the section says why, with Linear's
rate-limit headers, and how many items are not written yet. A **Container
document capacity** table follows when a team or project holds 90% of its
document cap or more ([`container-cap`](troubleshooting.md#container-cap)).

### How the run ends

A finished run succeeds. A partial run ends with a warning,
`sync: partial, will continue (<code>)`: Linear stopped it, a request to
Linear or a write failed, a state ref moved while it captured or wrote, or
a removal is held. It kept what it could record, and the next run goes on
from there. A run fails when it needs a person (the setup check,
a merge GitHub refuses again, an initial
sync from Linear not merged yet, a full container), and also when only the sync
pull request step did not finish (`sync: not finished (<code>); run it
again`, for `state-moved` or `github-failed` there): the next run tries
again. An initial sync from Linear stays pending until a person merges its
pull request or a new initial sync replaces it; closing the pull request or
deleting its branch does not cancel it
([`initial-pull-request-pending`](troubleshooting.md#sync-state)).
[Last lines](troubleshooting.md#last-lines) gives every last line and exit
code.
