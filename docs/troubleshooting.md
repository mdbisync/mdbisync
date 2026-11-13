# Troubleshooting

What each message of mdbisync means and what to do about it: how a run
ends, the setup check, the sync pull request, the initial sync, files left
out, input errors, request errors, and how to recover with an initial sync.
Setup and the workflows are described in [usage.md](usage.md); the `lint`
and `fix` messages of the `linear-format` hook are in
[linear-format.md](linear-format.md).

In the messages below, `<command>` is the command or action operation
(`sync`, `initial-sync` or `check`), and other words in angle brackets stand
for names, paths, numbers or GitHub's and Linear's own words.

## Where messages appear

Every run of the action or the command line gives the same information in
four places:

- **The last line.** The command line prints it to standard error; the
  action ends its step with it, as a failure or, for a partial run, as a
  warning. It names a code in parentheses, for example
  `sync: partial, will continue (stopped)`.
- **The job summary.** What the run did, by path and count, with tables of
  the files it failed, skipped or left out. It never holds document content.
- **The `code` output of the action**, for a later workflow step: the same
  code, or empty when the run succeeded.
- **The run report**, when the `report-file` input is set: the same facts
  as JSON, with `exitStatus` `success`, `warning` or `failure`.

The command line's exit code:

| Exit code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | An error that stopped the run: the message starts with `error:`. Look it up on this page; see [Errors found during the run](#errors-found-during-the-run) and [Errors that point to a bug](#errors-that-point-to-a-bug). |
| 2 | The command or its inputs are wrong. Nothing ran. See [Input errors](#input-errors). |
| 3 | A setup error. Either the setup check failed and nothing was written, or GitHub keeps refusing the merge (`merge-blocked`) on the sync pull request: then the run kept Linear's changes in its state and on the sync branch, but wrote no tracked-branch changes to Linear. |
| 4 | The sync has no state: run an initial sync, or merge the pull request of the one that ran. Nothing was written. |
| 5 | The run did not finish. A sync is partial and the next run goes on; run an initial sync again with the same inputs. Except `container-cap`: running again fails the same way until a person makes room (see [`container-cap`](#container-cap)). |
| 10 to 15 | `<command>: not implemented`: this build does not have the command. |

The action has no exit code: its step fails, or warns for a partial sync,
with the same last line. An error that stopped the run ends the action's
step with the bare message, without `error:`.

## Last lines

| Last line | Meaning and what to do |
| --- | --- |
| `<command>: stopped before any write (<code>): <detail>` | The setup check, or the sync's state, stopped the run before it wrote anything. The code is one of the [setup check codes](#setup-check) or [sync state codes](#sync-state). When the quickstart has a section that fixes it, the line ends with `. How to fix it: <link>`. |
| `warning: <command>: partial, will continue (<code>)` | A sync run did part of its work and recorded what it finished. The next scheduled run goes on from there; nothing to do unless it repeats. See [Partial sync runs](#partial-sync-runs). |
| `<command>: stopped by Linear before any write; run it again once the limit has reset` | Linear's rate limit stopped an initial sync or a check before it wrote anything. Wait for the reset time in the job summary and run it again. |
| `<command>: stopped before any write (container-cap); reduce additions or check document-cap` | See [`container-cap`](#container-cap). |
| `<command>: not finished (<code>); run it again with the same inputs` | An initial sync stopped part way. Run it again with the same direction and `confirm`; it skips what it already did. See [Initial sync](#initial-sync). |
| `<command>: not finished (sync-branch-changed); merge or close the pull request of the sync branch and delete the branch, then run it again` | See [`sync-branch-changed`](#initial-sync). |
| `<command>: setup error (merge-blocked): GitHub refuses again to merge the sync pull request (<reason>)` | See [`merge-blocked`](#the-sync-pull-request). |
| `<command>: stopped short (initial-pull-request-pending): an initial sync from Linear waits for a person to merge it` | See [`initial-pull-request-pending`](#sync-state). |
| `<command>: not finished (<code>); run it again` | The sync pull request step did not finish (`state-moved` or `github-failed`); the next run tries again. See [The sync pull request](#the-sync-pull-request). |
| `<command>: not implemented` | This build does not have the command. Use a release that has it. |
| `error: <message>` (the action: `<message>` alone) | An error stopped the run. Look the message up on this page. |

## Setup check

Every run checks its setup before it writes anything; `check` runs only
that. The job summary has one row per check, with the state `passed`,
`failed`, `warning` or `not-checked` (an earlier failure made it impossible
to check). A failed row, the summary's first line and the run's last line
link the [quickstart](quickstart.md) section that fixes the failure, for
example [GitHub App](quickstart.md#github-app) for a missing permission:

| Check | What it checks |
| --- | --- |
| `linear-credentials` | The Linear app's token works and has the read and write scopes. |
| `github-access` | The GitHub token can read the repository and has the permissions the sync needs. |
| `github-app` | GitHub has the bot account of the App named by `app-slug`; the sync's commits name it as their author. |
| `merge-commits` | The repository allows merge commits. |
| `linear-format-hook` | `.pre-commit-config.yaml` has the `linear-format` hook. |
| `annotations` | Every `linear-team` and `linear-project` in a `README.md` front matter is valid. |
| `annotation-targets` | Every annotated team and project exists in Linear, once. |
| `left-out-files` | A warning that lists files left out by a title collision; the run goes on. |
| `security-hooks` | A warning when no pre-commit hook is marked `alias: security`; the run goes on. |

A failed check stops the run with one of these codes (exit code 3). The
last line and the summary row give its detail, shown here:

| Code | Detail | Meaning | What to do |
| --- | --- | --- | --- |
| `linear-credential-failed` | `the Linear token lacks the scope <scopes>`, `Linear refused the OAuth app client credentials`, `Linear refused the token while reading teams`, or Linear's refusal of the token request | Linear refused the app's client ID or secret, or the token lacks a scope. | Check the `MDBISYNC_LINEAR_CLIENT_ID` and `MDBISYNC_LINEAR_CLIENT_SECRET` secrets, and that the Linear app has client credentials with read and write. |
| `github-credential-failed` | `the GitHub token was refused (HTTP 401)`, `the GitHub token cannot see the repository (HTTP <status>)` | The GitHub token cannot read the repository. | Check the GitHub App's installation on this repository and the `MDBISYNC_APP_CLIENT_ID` variable and `MDBISYNC_APP_PRIVATE_KEY` secret. |
| `missing-permission` | `the GitHub token lacks <permissions>`, perhaps with `(<permissions> not checked without it)` | The GitHub token lacks the permissions named. | Give the GitHub App contents, pull requests and workflows write, and checks and commit statuses read, then accept the new permissions on the installation. |
| `github-app-not-found` | `GitHub has no App account <slug>[bot]; give app-slug the App token step's output app-slug` | GitHub has no App with the slug the action was given. | Give the action's input `app-slug` the output `app-slug` of the step that mints the App token, as the example workflows do. |
| `merge-commits-required` | `merge commits are not allowed in the repository settings`, `GitHub did not show whether merge commits are allowed` | The repository does not allow merge commits, or GitHub did not say. | Turn on **Allow merge commits** in the repository settings. |
| `linear-format-hook-required` | `.pre-commit-config.yaml has no linear-format hook`, `.pre-commit-config.yaml is not valid YAML`, `.pre-commit-config.yaml has no "repos" list` | The hook configuration is missing or broken. | Add the hook, pinned to a release (see [usage.md](usage.md#release-builds-and-pins)). |
| `invalid-annotation` | The problems, joined by `;` | A `README.md` front matter names a team or project in a way the run cannot use. | Fix the front matter; see [Annotation problems](#annotation-problems). |
| `no-annotations` | `no folder has linear-team or linear-project in its README.md front matter` | Nothing is mapped. | Annotate at least one folder (see [usage.md](usage.md#folder-mapping)). |
| `linear-teams-not-visible` | `the Linear app saw no team in two lookups, so none of the annotated teams (<teams>) can be found: check the app's team access in Linear` | The Linear app saw no team at all, twice. | In Linear, give the app access to the annotated teams. |
| `annotation-target-not-found` | `not found in Linear: <names>` | An annotated team or project does not exist in Linear, or the app cannot see it. | Fix the name or key in the front matter, or give the app access to the team. |
| `annotation-target-ambiguous` | `more than one match in Linear: <names>` | More than one team or project in Linear matches an annotated name. | Name the team by its key, or rename one of the projects. |
| `annotation-target-shared` | `more than one folder maps to <names>` | More than one folder maps to the same team or project. | Map each team or project from one folder only. |

The setup check can also end with:

- `GitHub rate-limited the setup check while reading the repository (HTTP 403); run again later`
  or `GitHub rate-limited the setup check while checking <permission> (HTTP 403); run again later`
  or `GitHub rate-limited the setup check while reading the App's account (HTTP 403); run again later`:
  wait and run again.
- `GitHub answered HTTP <status> while checking <permission>`,
  `GitHub answered HTTP <status> while reading the repository` or
  `GitHub answered HTTP <status> while reading the App's account`: GitHub failed
  a request; run again, and if it repeats, check GitHub's status.
- `more than 250 Linear projects share the annotated names`: name fewer
  projects with the same name, or rename them in Linear.

The two warnings say:

- `<n> files left out, not synced: <path> (<rule>), …`: files with a title
  collision stay in git only. Rename one of each pair.
- `no pre-commit hook marked "alias: security": content is pushed unchecked`:
  nothing checks what comes from Linear before it is pushed. Add hooks marked
  `alias: security` if you want that (`mdbisync init --security-hooks` adds
  two examples).

## Sync state

The sync needs the state an initial sync records. Without it the sync
writes nothing and ends with exit code 4:

| Code | Message | What to do |
| --- | --- | --- |
| `initial-sync-required` | `refs/mdbisync/linear does not exist: run initial sync first. The sync wrote nothing.` | No initial sync has run, or its state is lost. Run an initial sync (see [Recovery with initial sync](#recovery-with-initial-sync)). |
| `initial-sync-required` | `An initial sync stopped before it finished: run it again with the same inputs first. The sync wrote nothing.` | Run the initial sync again with the same direction and `confirm: true`. |
| `initial-pull-request-pending` | `The pull request of the initial sync from Linear is not merged into <tracked branch> yet: a person reviews and merges it with a merge commit (it can remove files), then the sync runs. Closing the pull request or deleting its branch does not cancel this unmerged snapshot. To start over instead, close that pull request, delete the branch <sync branch> and run initial sync again to replace the snapshot. The sync wrote nothing.` | Review and merge that pull request with a merge commit. Closing it or deleting its branch alone leaves the snapshot pending. To start over, close it, delete the sync branch and run the initial sync again to replace the snapshot. |

## Partial sync runs

A partial sync run kept what it could record; the next run goes on from
there, so the job ends with a warning, not a failure. The summary says
which documents were written and which were not.

| Code | Meaning | What to do |
| --- | --- | --- |
| `stopped` | Linear's rate limit stopped the run, or a remaining-budget header ran low. The summary gives `Stopped: rate limited`, `Stopped: rate limited, retry after <n> s` or `Stopped: <header> is <n>, below <threshold>`, and Linear's rate-limit headers with their reset times. | Nothing; the next run goes on after the reset. If every run stops, run less often or sync fewer documents. |
| `linear-failed` | A request to Linear failed while the run read Linear's changes: `Capture partial, will continue: Linear failed <operation> (<error>).` | Nothing, unless it repeats; then see [Linear and GitHub request errors](#linear-and-github-request-errors). |
| `write-failed` | Linear failed or rejected some writes. The summary's **Failed** table names each path, the operation and the error. | Nothing for a passing failure. For one that repeats, look up the error below. |
| `state-moved` | A state ref moved while this run worked: another run, or a person, changed it. The run recorded nothing that the move could contradict. | Nothing; the next run writes again what is still missing. Do not push to the `refs/mdbisync/` refs by hand. |
| `removal-held` | Linear did not return some documents while their place listed none, which is also how a blank answer looks: `Removal held for <n> files`. The files stay. | Nothing; the next run removes them if Linear still does not have them. |

## `container-cap`

A Linear project or team holds at most a set number of documents, 1,000 by
default. Live, trashed and archived documents all count, and moving a
document to trash frees no space. The summary's **Container document
capacity** table warns from 90% (status `warning`) and stops the run before
any write when the planned additions would pass the cap (status
`over-cap`): `Nothing was written. Reduce planned additions or increase
document-cap after checking the container limit.`

What to do: add fewer files to that folder, or, when your Linear plan allows
more, set the `document-cap` input (`MDBISYNC_DOCUMENT_CAP` on the command
line) to the limit you have.

## The sync pull request

A failed check, or one GitHub still reports as pending past `check-deadline-minutes`
(default 60, range 10–1440), moves the whole batch to **Suspended changes
from Linear** on `mdbisync/suspended` (default branch names; see
[custom branch names](usage.md#the-sync-pull-request)). The normal pull request closes;
other documents continue through **Changes from Linear** on
`mdbisync/linear`. The run succeeds. While the suspended head's checks
are pending before the deadline, the normal lane waits to merge.

Suspended documents show a red `Cross` and one comment naming the failed
check and linking to its run when available, with annotations for that
file, or “did not finish in time”. Later failures edit that comment.
A blocked security-hook mark takes precedence over suspension, which
takes precedence over conflict. Suspended documents are frozen both ways:
Linear edits go only to the suspended lane; git edits wait for release.
Fix the document in Linear or fix CI on the tracked branch. Either change
updates that lane; when its head contains the current tracked tip and
passes, it merges, comments resolve, and suspended marks clear. Both
sides' edits then meet in the normal three-way merge.

The sync never reruns a check. Configure retries for flaky checks in your
repository's CI, or rerun them yourself; the latest result on the head
counts. The App needs no Actions permission. The deadline is separate
from `merge-grace-seconds` and starts again for a new head; its push time
is kept in a hidden HTML note in the pull request description. A check
that never registers is invisible to the deadline: GitHub can refuse the
merge for a missing required check instead (`merge-refused`, then
`merge-blocked`), and nothing is suspended or marked in Linear. Check
workflow filters and required-check names.

If the same check fails on the tracked branch's tip (`main` by default),
the normal pull request stays open and held instead: nothing is suspended,
no documents are marked for it, and no alert is written to Linear. The run
summary names the check and links to its run on that tip. Git-to-Linear
writes continue for other documents. Fix CI on the tracked branch. The
initial decision waits up to the deadline if the check still runs there;
a recorded red-main hold waits until the held checks have actually run
and passed there, then merges a new tip into the normal branch. If the
head already contains that tip and still fails, it is suspended without
restarting CI. Keep the hidden HTML notes in the description: they record
the head's deadline and the red-main hold. See
[suspension and release](sync-cycle.md#suspension-and-release) for the exact
comment text and mark limits.

Linear's changes reach the tracked branch through the sync pull request
(see [usage.md](usage.md#the-sync-pull-request)). Its step reports the codes below. `merge-refused` and `merge-blocked`
apply to either lane; the summary identifies a suspended merge refusal.

For **Suspended files waiting for a manual merge**, fix the listed
non-document files on the suspended branch (`mdbisync/suspended` by
default), not the normal branch. For a conflict with the tracked branch,
setting those files to the tracked branch's current versions removes the
conflict. To keep a combined version, commit it on the tracked branch
first, then use that version on the suspended branch. For binary assets
changed in Linear as well, reconcile the source in Linear too. Keep the
sync's recorded-base commit history and use ordinary commits; the next
run retries the merge. Do not merge the entire Linear state ref into the
suspended branch: it carries other documents that belong in the normal
lane.

Its step reports:

| Code | Meaning | What to do |
| --- | --- | --- |
| `merge-refused` | GitHub did not merge the sync pull request this time: `GitHub did not merge the sync pull request (<reason>); a later run tries again.` When GitHub refused because of merge conflicts (`Pull Request has merge conflicts`), the next run first merges the tracked branch into the sync branch, unless the head already holds the tracked branch's latest commit. | Nothing; a later run tries again. |
| `merge-blocked` | GitHub refused to merge again, on the same head and for the same reason (exit code 3). A refusal for merge conflicts repeats only on a head that already holds the tracked branch's latest commit. | When GitHub names a required check that is expected, make that check run on the sync pull request: check workflow filters and the required check's name. Otherwise let the sync's GitHub App merge into the tracked branch, for example by adjusting the branch's rules. A later run merges. |
| `conflict` | Linear's latest changes and the tracked branch, or the sync pull request's branch, change the same lines. For documents the sync merges with conflict markers: this run into Linear's state, a later run into the sync branch. | Resolve the markers on either side ([conflicts.md](conflicts.md#resolving-a-conflict)). A conflicting file that is not a document waits: merge both the tracked branch and the `linear` state ref (`refs/mdbisync/linear` by default) into the sync branch and resolve it there; the sync keeps those commits. |
| `initial-pull-request-pending` | The sync branch holds an initial sync from Linear that no one has merged yet (exit code 4). | Review and merge it with a merge commit. |
| `state-moved` | The sync branch moved while the run worked. | Nothing; the next run updates the pull request. |
| `github-failed` | A GitHub request for the sync pull request failed or got no answer. | Nothing, unless it repeats; then check GitHub's status and the App's permissions. |

## Initial sync

An initial sync that stops part way records no state; the summary says what
it did. Run it again with the same direction and `confirm`: it skips what it
already wrote, and finds a document created just before a crash by its title
instead of creating it twice.

| Code | Meaning | What to do |
| --- | --- | --- |
| `stopped` | Linear's rate limit stopped it. | Run it again after the reset time in the summary. |
| `write-failed` | Linear failed or rejected a write; the **Failed** table names it. | Run it again; if the same document fails, look up its error. |
| `state-moved` | A state ref moved while it worked: another run is working on this repository. | Wait for the other run, then run the initial sync again. Disable the sync workflow during an initial sync. |
| `container-cap` | See [`container-cap`](#container-cap). | |
| `pull-request-failed` | From Linear: the state is recorded, but the pull request could not be opened. | Run it again with the same inputs to open it. |
| `sync-branch-changed` | From Linear: the sync branch holds commits this initial sync did not make, so it recorded nothing. | Merge or close the sync branch's pull request and delete the branch, then run it again. |

## Skipped documents

The sync summary's **Skipped** table lists documents the run did not write
this time:

| Code | Meaning |
| --- | --- |
| `edited-in-linear` | Changed in Linear since it was read; the next run takes that change in and writes again. |
| `missing-in-linear` | Not found in Linear, or in its trash; the next run takes that in. |
| `conflict` | Changed on both sides in a way git cannot merge; it is written when the conflict is resolved. |
| `suspended` | Waits for its suspended changes to reach the main branch. |
| `renamed-to-unwritable` | Its file was renamed to one that is in conflict or left out; the document stays as it is until that is fixed. |

None needs action unless the same document stays skipped.

## Decided by the conflict rules

When a file and its document change on both sides in ways that cannot both
apply, a rule decides, and the summary's **Decided by the conflict rules**
table says which:

| Code | What happened |
| --- | --- |
| `edit-wins-delete` | One side deleted, the other changed: the change wins. A document deleted in git but changed in Linear is kept, and its file comes back through the sync pull request. A document deleted in Linear but changed in git is restored with the git text; if Linear no longer has it at all, a new one is created and its old comments are lost. |
| `rename-and-edit` | Renamed on one side and edited on the other: both apply. |
| `git-path-wins` | Renamed differently on both sides: the git path wins, and the document gets the comment "The title was set back because the file was renamed in git at the same time. Rename it again to change it." |

Text changed on both sides in the same lines gets conflict markers, which
either side resolves by editing the text; [conflicts.md](conflicts.md)
shows how.

## Files left out

A file left out stays in git only, and its document stays as it is, until
the reason is fixed. The summaries list each with its rules:

| Rule | Meaning | What to do |
| --- | --- | --- |
| `duplicate-title` | Two files map to one document title (their names differ only in letter case or Unicode normalization). | Rename one of them. |
| `title-too-long` | The title made from the file's path is longer than Linear accepts. | Use a shorter file name or folder path. |
| `content-too-long` | The text is longer than the 250,000 characters Linear accepts. | Split the file. |
| `outside-annotations` | The file is above every annotated folder. | Move it into an annotated folder, or annotate a folder above it. |
| `not-a-regular-file` | The path is a symbolic link or another kind of file. | Replace it with a regular file. |
| `binary` | The `.md` file does not hold text. | Fix or rename the file. |
| `stored-in-lfs` | The Markdown file itself is stored in Git LFS. | Store Markdown files in git directly. |
| `upload-too-large` | The document links a file over Linear's 10 MB upload limit. | Make the file smaller, or link it from somewhere else. |
| `upload-unreadable` | The document links a file the run cannot read, such as an LFS object stored with LFS extensions or one the LFS server does not have. | Store the file in git or plain LFS, or push its LFS object. |
| `image-blocked` | From Linear: an image or file the document embeds is not an upload of the workspace (an external URL, a `data:` URI, a path), or its upload is gone, over 10 MB, redirected or not a supported type. The file keeps the tracked branch's text. | Upload the files in Linear instead of linking them. The first sync after the initial sync (once its pull request, if any, is merged) marks the document and comments which images to fix. |
| `download-failed` | From Linear: a file the document embeds could not be downloaded this time (a network error, Linear's rate limit or a server error) or placed next to it. The file keeps the tracked branch's text. | Nothing; the next sync reads the document again. If it repeats, check the run's log for the asset error. |
| `security-hook` | From Linear: a hook marked `alias: security` flagged the document's text or a file it embeds. The file keeps the tracked branch's text. | Remove what the hook flagged from the document in Linear. |
| `security-unchecked` | From Linear: the security hooks did not see this text, because their step did not run or the tracked branch moved after it. | Nothing; the next run checks it. If it repeats, check that the hooks step runs. |
| `title-not-a-path` | From Linear: the file the document's title names would map to a different document, for example because it lands in a folder another annotation owns. | Rename the document in Linear. |
| `front-matter-boundary` | From Linear: the document's text starts with something that reads as front matter, so it would not stay the file's body. | Change the start of the document in Linear. |
| `download-retry` | An upload download timed out, lost its connection, or returned 429 or a server error. The document stays out of this capture without a mark. | The next run retries automatically. |
| `capture-translation` | The run could not turn the document's text from Linear into the file's text. | Check the document in Linear for unusual content, or report it as a bug. |

The `linear-format` hook's rules leave a file out too until it is fixed:
`footnote`, `subscript`, `table-escaped-pipe`, `table-hash-cell`,
`image-in-link`, `table-alignment`, `link-title`, `image-title`,
`code-in-emphasis`, `hard-break-backslash`, `git-conflict-marker`,
`url-in-html`, `block-first-in-list-item`, `image-not-in-repository` and
`image-file-missing`. Each is described, with its fix, in
[linear-format.md](linear-format.md#lint-rules).

The initial sync also lists:

- `<files>: over the upload limit of <n> bytes` for `upload-too-large`;
- `<files>: stored with LFS extensions, which are not supported` and
  `<file> cannot be read: <reason>` for `upload-unreadable`.

## Other summary lines

- `linear-content-too-large-to-write-back`, as
  `linear-content-too-large-to-write-back: "<path>" (<n> characters; limit 250000). Preserved in git; Linear will not accept it back if it is changed in git while still over the limit.`
  A document in Linear is longer than Linear accepts through its API. The
  sync keeps its text in git, but if the file changes in git while it is
  still that long, the write is refused and the file is left out with
  `content-too-long`. Shorten it in git or in Linear.
- `Content is pushed unchecked: no security hooks are configured.` See the
  `security-hooks` warning above.
- `The document id map was lost: rebuilt by matching titles to paths`: see
  [Recovery with initial sync](#recovery-with-initial-sync).
- The run report's `paths` field names the file-name rule
  `percent-encode-unsafe-segments`: titles become file names as
  [usage.md](usage.md#file-names-for-titles) describes.

## Annotation problems

The `invalid-annotation` check names the `README.md` and the problem:

| Problem | Message | What to do |
| --- | --- | --- |
| `invalid-annotation` | `<readme>: the front matter with linear-team or linear-project is not valid YAML` | Fix the YAML. |
| `invalid-annotation` | `<readme>: <key> must be a non-empty name` | Give the key a team or project name. |
| `project-without-team` | `<readme>: names a project, but neither it nor a folder above names a team` | Add `linear-team` to this folder or a folder above. |
| `nested-team` | `<readme>: names a team inside the folder of team "<team>" (<folder>)` | Map one team per folder tree; remove the inner `linear-team`. |
| `nested-project` | `<readme>: names a project inside the folder of project "<project>" (<folder>)` | Map one project per folder tree; remove the inner `linear-project`. |

## Input errors

These end the command with exit code 2 before anything runs; the action's
step fails with the same message:

| Message | What to do |
| --- | --- |
| `missing command`, `unknown command: <name>` | Run `mdbisync --help` for the commands. |
| `mdbisync requires Node 24 or newer; install it before running the hook.` | Install Node 24 or newer. |
| `the input <name> is required` | Set the input in the workflow, or its `MDBISYNC_*` environment variable on the command line. |
| `the input repository must be "owner/name" (it defaults to the workflow's repository)` | Give `repository` as `owner/name`, or leave it empty in a workflow. |
| `the input document-cap must be a positive safe integer` | Give a whole number above zero. |
| `the input merge-grace-seconds must be an integer from 0 to 120` | Give a whole number of seconds from 0 to 120. |
| `the input check-deadline-minutes must be an integer from 10 to 1440` | Give a whole number of minutes from 10 to 1440. |
| `the input app-slug is required: give it the App token step's output app-slug` | In the workflow, give the mdbisync steps `app-slug: ${{ steps.app-token.outputs.app-slug }}`, as the example workflows do. |
| `the input app-slug must be a GitHub App slug (letters, digits and hyphens)` | Give the App's slug, not its name or its bot login (`<slug>[bot]`); the token step's output `app-slug` is it. |
| `the input direction is required (initial sync never picks a direction itself)`, `the input direction must be one of git-to-linear, linear-to-git, not "<value>" (initial sync never picks a direction itself)` | Choose `git-to-linear` or `linear-to-git`. |
| `remote "<name>" is not a valid remote name` | Use a valid git remote name. |
| `<tracked-branch or sync-branch> "<name>" is not a valid branch name: <problem>` (the problem can be `starts with "-"`) | Use a valid branch name. |
| `the tracked branch and both sync lane branches must differ`, `one of the tracked branch and the sync branch is a folder of the other` | Choose two separate branch names, neither inside the other, such as `main` and `mdbisync/linear`. |
| `refPrefix "<prefix>" is not a valid ref prefix: <problem>`, `refPrefix "<prefix>" must start with "refs/" and name a folder under it`, `refPrefix "<prefix>" must not be under refs/heads, refs/tags or refs/remotes` | Set `state-ref-prefix` to a folder under `refs/` of its own, such as the default `refs/mdbisync/`. |

## Errors found during the run

These stop the run once it has started: the command line prints
`error: <message>` and exits with code 1, and the action's step fails with
the message. Most come from the workflow's configuration:

| Message | What to do |
| --- | --- |
| `the direction and confirm inputs belong to an initial sync, and only to it` | Remove `direction` and `confirm` from the sync and check steps. |
| `unknown operation: <name> (expected one of: <operations>)` | Set the action's `operation` to `sync` or `initial-sync`. |
| `unknown security-step: <name> (expected one of: <steps>, or empty)` | Set `security-step` to `stage` or `apply`, or leave it empty. |
| `cleanup-tokens belongs before the stage step, not apply` | Move `cleanup-tokens: true` to the `stage` step. |
| `token cleanup requires exclusive use of the Linear app` | Token cleanup runs only with a Linear app that nothing else uses (see the README). |
| `RUNNER_TEMP is not set; the staged security steps run in a GitHub Actions job` | Use `security-step` only in GitHub Actions; leave it empty on the command line. |
| `the staged candidates come from another version of the action`, `the staged manifest names a file that is not a content hash` | Pin the `stage` and `apply` steps to the same release, and let nothing else write to the runner's temporary folder between them. |
| `invalid security hook configuration` | Fix the hooks marked `alias: security` in `.pre-commit-config.yaml`. |
| `security hooks require pre-commit on PATH; install pre-commit before capture` | Install `pre-commit` before the mdbisync step (the example workflows do). |
| `the tracked branch "<branch>" does not exist on remote "<remote>"` | Set `tracked-branch` to a branch that exists. |

## `init` errors

`mdbisync init` stops before it writes any file, with exit code 2 and
`init: <message>`:

| Message | What to do |
| --- | --- |
| `run init at the repository root` | Run it in the folder that holds `.git`. |
| `provide --folder with --team and/or --project` | Name at least one folder, each with a team or project. |
| `unknown option: <flag>`, `<flag> needs a value`, `<flag> must follow --folder`, `<flag> was given twice for a folder`, `<flag> was given twice`, `choose security hooks once` | Fix the flags; `mdbisync init --help` lists them. |
| `--release-sha must be a full 40-character commit SHA`, `--release-version must be a version such as v1.2.3` | Give the release commit SHA and version (see [usage.md](usage.md#release-builds-and-pins)). |
| `release <version> is older than <minimum>, the release these workflows are written for and checked against. Use <minimum> or later` | Pick `<minimum>` or a later release (see [`init`](configuration.md#init)): the workflows pass action inputs that the older release lacks. |
| `paths must stay inside the repository`, `setup destinations must not contain symlinks`, `a setup folder path names a regular file` | Give folder paths inside the repository, without symbolic links. |
| `conflicting folder options: <path>` | Give each folder its options once. |
| `invalid YAML configuration`, `.pre-commit-config.yaml needs a repos list`, `invalid pre-commit repository entry` | Fix `.pre-commit-config.yaml` or the `README.md` front matter. |
| `<folder>/README.md already has a different <key>` | Edit or remove that annotation first. |
| `existing linear-format hook uses a different repository or release` | Update the hook's `rev` by hand to the release you pass, or pass the release it uses. |
| `existing <hook> hook differs from the security example; reconcile it first` | Change or rename your hook, or leave out `--security-hooks`. |
| `existing workflow differs: <name>` | Merge the changes into your workflow by hand, or move it aside. |

An annotation problem from [Annotation problems](#annotation-problems) can
also end `init`.

## Linear and GitHub request errors

These name the request that failed. They appear in the summary's
**Failed** table, after `Capture partial, will continue`, or as the last
line. A single failure needs nothing: the next run tries again. One that
repeats points to Linear's or GitHub's status, the app's access or the
document named.

| Message | Meaning |
| --- | --- |
| `<operation>: Linear client stopped (<why>)` | Linear's rate limit or a low budget stopped the run; see `stopped` in [Partial sync runs](#partial-sync-runs). |
| `<operation>: Linear error <code> (HTTP <status>, request <id>): <message>` | Linear rejected the request. `INPUT_ERROR` usually names a document Linear no longer has or does not accept; `AUTHENTICATION_ERROR` means the app lost access. |
| `<operation>: Linear answered HTTP <status> (request <id>)` | Linear failed the request. |
| `<operation>: request to Linear failed (<cause>)` | The connection broke or timed out. |
| `<operation>: <field> is <n> characters, Linear accepts at most <limit>` | A title or text is too long for Linear; see `title-too-long` and `content-too-long`. |
| `<operation>: written, but reading back the stored record failed` | Linear took the write but the read that confirms it failed. The next run checks it. |
| `<operation>: Linear reported another page without a cursor`, `<operation>: Linear reported success: false` | Linear answered in a way the run cannot use. Run again; report it if it repeats. |
| `oauth.token: Linear refused the token request (<reason>)` | Linear refused the app's credentials; see `linear-credential-failed`. |
| `oauth.revoke: Linear did not confirm the revocation (HTTP <status>)`, `<operation>: request to Linear failed` | Revoking the run's token failed. |
| `the run's Linear token could not be revoked: <error>`, `post: the run's Linear token could not be revoked: <error>` | A warning only: Linear expires the token on its own. The action's post step tries again after the run. |
| `token cleanup revocation failed` | Token cleanup could not revoke an old token. Run again; check the app in Linear if it repeats. |
| `FileUpload: Linear returned no upload target`, `FileUploads: Linear returned no upload target`, `<operation>: storage request failed`, `<operation>: storage answered HTTP <status>` | Uploading a linked file failed. |
| `upload destination is not allowed` | Linear gave an upload address outside its own storage; the run refused to send the file there. |
| `asset destination is not allowed`, `asset redirect destination is not allowed`, `asset could not be downloaded`, `asset exceeds the download limit`, `asset destination already exists` | Downloading a file a document embeds failed or was refused (only Linear's own storage, up to 10 MB). An initial sync from Linear leaves the document out with `image-blocked` or `download-failed`. |
| `GitHub answered HTTP <status> while <what>`, `GitHub did not answer while <what>` | A GitHub request failed. `<what>` is one of: listing open pull requests, reading a pull request, opening a pull request, updating a pull request, closing a pull request, sending a request to the pull request API, reading the check runs of the sync pull request, reading the commit statuses of the sync pull request, reading the annotations of a failed check run, merging the sync pull request. A failed read of a check run's annotations does not stop the run: the suspended documents' comments name that check without them, and the run summary says so. |
| `git <arguments> failed with exit code <n>: <output>` | A git command failed; its own output follows. Often a network problem or missing rights to push. |
| `refusing to move <ref> to a commit that does not descend from its current value` | A state ref or the sync branch was changed by hand. Undo that change, or recover with an initial sync. |

## Errors that point to a bug

These messages mean the run met a state its own checks rule out. It stopped
without writing more. Run it again once; if the message repeats, report it
as a bug with the message and the job summary (they hold no document
content).

- `a state ref moved while the run was writing`
- `state moved while recording document marks`
- `the planned document for <path> was not listed`
- `document-links: apply before prepare`
- `the uploads transform was not prepared`
- `project "<project>" of team "<team>" was not resolved`, `team "<team>" was not resolved`
- `the text of <path> was not read`, `the content of <path> was not read`
- `the recorded tree maps <n> files to other documents`
- `Comment identity does not match its document`
- `Updated comment identity does not match`, `Created comment identity does not match`
- `container documents were not read`
- `Invalid merge-file conflict output`, `git merge-tree gave no tree`
- `invalid repository path "<path>"`
- `git object <id> is missing`, `git object <id> is a <type>, not a blob`
- `a push names the same ref twice`
- `ids.json has an invalid entry for a path`; `reserved-ids.json`, `superseded-ids.json`, `uploads.json` or `written.json` `has an invalid entry`
- `<file> is missing in state commit <commit>`, `<file> in <commit> is not valid JSON`, `<file> in <commit> is not a JSON object`
- `run initial sync first`
- ``the sync writes to Linear only after initial sync has recorded `linear` ``
- `the previously recorded document places could not be resolved`
- `LFS did not return a pointer`, `LFS returned a pointer to other content than it was given`
- `Document and id entry do not match`
- `Status reconciliation requires document content`
- `A marked document requires a comment target`
- `a document has an invalid update time`
- `no safe destination for a document`
- `a linked file is not in the upload cache`

A state commit that cannot be read can also be recovered with an initial
sync, below.

## Recovery with initial sync

The sync keeps its state in three refs under `refs/mdbisync/` (or the
`state-ref-prefix` you set): `linear`, what Linear held at the last run;
`ids`, which document each file is; and `uploads`, the Linear address of
each linked file. Lost state is handled like this:

- **`ids` lost:** the next sync rebuilds it by matching titles to paths and
  says so in its summary. A document renamed in Linear since the last run
  comes back as a new file next to its old one.
- **`uploads` lost:** the next sync uploads each linked file again and
  rewrites the documents that link one, once.
- **The sync branch deleted:** the next sync creates it again, except while
  an initial snapshot from Linear remains unmerged; that run refuses and
  writes nothing until a person merges or a new initial sync replaces it.
- **`linear` lost, an initial sync that did not finish, or a state you do
  not trust:** the sync refuses with `initial-sync-required` and writes
  nothing. Recover with an initial sync.

To recover with an initial sync:

1. Disable the sync workflow and stop your own dispatch timer, if you run
   one ([own scheduler](own-scheduler.md#stop-the-timer-during-an-initial-sync)),
   so a sync cannot replace the initial sync while it waits in the queue.
2. Choose the side that is right. `git-to-linear` makes Linear equal to the
   tracked branch: documents keep their ids and comments and get the file's
   text, and documents that match no file go to Linear's trash.
   `linear-to-git` makes the tracked branch equal to Linear through one pull
   request and writes nothing to Linear. The steps of each are in
   [initial-sync-git-to-linear.md](initial-sync-git-to-linear.md#recovery)
   and [initial-sync-linear-to-git.md](initial-sync-linear-to-git.md).
3. Run the initial sync workflow with that direction and `confirm`
   unchecked. This dry run lists what would be created, overwritten,
   removed and left out, and writes nothing. Read it.
4. Run it again with `confirm` checked. If it stops part way, run it again
   with the same inputs until it finishes.
5. For `linear-to-git`, review and merge its pull request with a merge
   commit.
6. Enable the sync workflow, and start your timer again if you run one.

To abandon an initial sync from Linear whose pull request is still open,
close the pull request, delete the sync branch (`mdbisync/linear` by
default) and start again from step 2.

## Report output errors

| Message | Meaning and what to do |
| --- | --- |
| `cannot write report text: expected printable Unicode text of at most <limit> characters` | A report exceeds its output limit or an output field has an unexpected type. Normal Unicode Markdown is preserved, and control characters in display text are shown as Unicode escapes. Reduce the report size; if the message repeats for a small report, report the error with its operation and code. |
| `cannot write report metadata: expected a non-negative safe integer` | A workflow identifier or count has an invalid type or value. Check the upstream response before retrying; an invalid workflow identifier is never used as an evidence directory. |
| `report destination must stay inside the configured output directory` | A derived output path would leave its selected directory. Check the output configuration and file name. |
