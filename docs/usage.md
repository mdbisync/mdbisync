# Using mdbisync

How to set up and run mdbisync in a repository: how folders map to Linear,
the checks every run makes, the workflows, both directions of the initial
sync, the sync pull request, and how to pin a release. The setup steps (the
Linear OAuth app, the GitHub App, the secrets and the workflows) are on
[mdbisync.com](https://mdbisync.com/#setup). How Markdown is kept in
Linear's form is in [linear-format.md](linear-format.md), and conflicts, when
both sides change one document, in [conflicts.md](conflicts.md).

## Generate repository files

Run the released CLI at your repository root. Supply the full release commit
SHA used by the action and hook, plus the folders to synchronize:

```sh
mdbisync init --release-sha <release-sha> --release-version vX.Y.Z \
  --folder notes --team ENG \
  --folder notes/planning --project "Field notes" \
  --no-security-hooks
```

`--folder` starts a folder's options; its `--team` and `--project` names
apply only to that folder. A project can inherit a team from an ancestor.
`--release-version` is an optional workflow comment; the SHA determines
what runs. The command writes both sync workflows and `pre-commit.yml`,
adds the required `linear-format` hook with that same SHA, and annotates
the folders' `README.md` files. It preserves their bodies and other front
matter, and keeps custom hooks. Identical files are left unchanged on a
rerun. Conflicting workflows, annotations or hook pins cause an error
before any file is written; reconcile those files before retrying.

Use `--security-hooks` for two optional examples marked `alias: security`:
Gitleaks in a Docker image pinned by version and SHA-256 digest, and a
private-key pattern hook. Docker must be available wherever those hooks
run. Review these examples for your repository's privacy requirements;
without security hooks, runs warn that content is pushed unchecked.

Flags work without a terminal. With a terminal attached, `init` asks for
missing setup choices. It changes local files only and prints the remaining
admin steps: apps, secrets, merge commits, local hook installation and the
first initial-sync dry run. See `mdbisync init --help` for the flags.

## Folder mapping

A folder maps to Linear through its `README.md` front matter:

```yaml
---
linear-team: ENG            # a team, by key or name
linear-project: Field notes # a project of that team
---
```

A folder names the team, a folder below it (or the same folder) names the
project, and every folder below inherits both. Files in folders between the
team folder and a project folder are team documents. Deeper folders become a
path in the document title: `notes/guides/install.md` under a project folder
`notes/` is the document `guides/install`. Only `.md` files with text content
are synchronized; files above every annotated folder are not. Two files whose
titles differ only in letter case or Unicode normalization are both left out
and reported.

## Setup check

Before it writes anything, every run checks that the Linear token works and
may write, that the GitHub token has contents, pull requests and workflows
write and checks and commit statuses read, that merge commits are allowed,
that `.pre-commit-config.yaml` has the `linear-format` hook, that every
annotation is valid and its team and project exist in Linear, and
whether pre-commit hooks marked `alias: security` exist (without them the run
goes on and says that content is pushed unchecked). Files left out by a title
collision are listed too, without stopping the run. The result goes to the
job summary as names and states, never document content. A failure names
what is missing and links the [quickstart](quickstart.md) section that fixes
it. `check` runs it alone.

The command line reads the action's inputs (see `action.yml`) from
environment variables: `MDBISYNC_LINEAR_CLIENT_ID` for `linear-client-id`,
and so on.

## Workflows

Copy the workflow templates from
[examples/](../examples/)
into `.github/workflows/`:

- `mdbisync-initial-sync.yml` runs the initial sync by hand from the Actions
  tab, with a `direction` and a `confirm` box (unchecked: a dry run).
- `mdbisync.yml` runs the sync on every push to `main`, every five minutes
  and by hand. GitHub runs schedules only on the default branch, may start
  them late, and turns them off in a public repository after 60 days
  without activity. Until the initial sync has run, each sync run writes
  nothing and fails with `initial-sync-required`.

Both share the concurrency group `mdbisync`, so runs of one repository never
overlap. GitHub keeps one pending run per group and a newer one replaces it,
so a sync queued behind a running one can replace a pending initial sync:
disable the sync workflow before you start an initial sync, and enable it
when the initial sync has finished.

Both install `pre-commit`, which the repository's security hooks need on
content from Linear (a workflow of your own must install it before the
mdbisync step; without it the run stops and marks no document as a security
failure), and run the hooks in a step of their own, between two
mdbisync steps:

1. `security-step: stage` reads Linear's changes into the runner's
   temporary directory, with Linear's answers to its reads, and writes
   nothing to git or Linear;
2. "Run the security hooks" runs the hooks marked `alias: security` on them
   and records their findings (hook and line, never the matched text). It
   holds no Linear secret or token and no App token, so a hook cannot read
   them, not even from another process's environment. Give this step only
   the keys your hooks need, in its `env:`;
3. `security-step: apply` runs the sync (or the initial sync) with those
   findings. It takes Linear's changes from the stage step's answers
   instead of reading them again, so a run reads Linear once and pushes
   what the hooks saw; a change made in Linear after the stage step waits
   for the next run. A document whose blocked or conflict mark may change
   is read again first, so a mark never overwrites an icon set in the
   meantime, and the rest of the run reads Linear itself. A
   change the hooks have not seen, because the hooks step did not run or
   the tracked branch moved, is not pushed; the next run checks it.

This keeps the secrets out of what a hook can read. It does not contain a
hook that attacks the runner: the hooks step shares the runner's disk with
the other steps, and a hook that rewrites files there can reach a later
step that holds the secrets. Use only hooks you trust. Each workflow mints the GitHub App's installation token with
`actions/create-github-app-token`, checks out without stored credentials,
and gives the App token and the Linear secrets to the mdbisync steps only.
Without `security-step` (as from the command line), the hooks run in a
child process of the mdbisync step whose environment holds only `PATH`,
`HOME` and `LANG`.
The action revokes the run's Linear token when it ends, and its post step
revokes it again after a failed or cancelled run. A repository needs the
variable `MDBISYNC_APP_CLIENT_ID` and the secrets `MDBISYNC_APP_PRIVATE_KEY`,
`MDBISYNC_LINEAR_CLIENT_ID` and `MDBISYNC_LINEAR_CLIENT_SECRET`.

## Initial sync from git to Linear

`initial-sync` with `direction: git-to-linear` makes Linear equal to the
tracked branch. Without `confirm: true` it is a dry run: it lists by path
what it would create, overwrite and move to Linear's trash, and the files it
leaves out, and writes nothing. The files left out include documents that
link a file over Linear's 10 MB upload limit (`upload-too-large`) or an LFS
object stored with LFS extensions, which the run cannot read
(`upload-unreadable`), each with the files that
cause it; the dry run judges a file in LFS by its pointer, so it uploads and
downloads nothing. An LFS object missing from the remote is found only by
the confirmed run. With `confirm: true`:

- a document whose title is a file's path keeps its id, comments and history
  and gets the file's text (front matter stays in git); a file without a
  document gets a new one; a document that already holds the text is not
  written;
- the documents of the annotated projects and team zones that match no file
  are moved to Linear's trash, from which they can be restored;
- a relative link to another synchronized document, such as
  `[setup](../guide.md#setup)`, becomes a link to that document in Linear
  (`https://linear.app/<workspace>/document/<id>#setup`), also when the
  document is created in the same run; the recorded file keeps the link as
  it was written. Links to files that are not synchronized documents stay as
  they are;
- document ids go to `refs/mdbisync/ids` as the run goes, and at the end
  one push records `refs/mdbisync/linear` (the tracked branch with each
  synchronized file as Linear stores it), `ids` and `uploads`.

A run that stops early (Linear's rate limit, a rejected write) records no
`linear` and exits with code 5. Run it again with the same inputs: it skips
the documents it already wrote, and a document created just before a crash
is found by its title, not created twice. When the state refs are lost, a
new confirmed run rebuilds them without duplicating documents.

Before creating documents, the dry run and sync report containers at or above
90% of their document cap. Counts include live, trashed and archived documents
returned by Linear, plus planned additions; trashing documents frees no space.
Above the cap, a confirmed initial sync or `sync` stops before uploads,
document writes or state pushes and exits with code 5 (`container-cap`).
Set the `document-cap` action input or `MDBISYNC_DOCUMENT_CAP` environment
variable to a positive integer to override the default of 1,000.

## Initial sync from Linear to git

`initial-sync` with `direction: linear-to-git` makes the synchronized folders
of the tracked branch equal to Linear through one pull request, and writes
nothing to Linear. Without `confirm: true` it is a dry run: it lists by path
the files it would overwrite, create and remove, and what it leaves out, and
writes nothing. With `confirm: true`:

- a file whose path a document's title names gets the document's text (its
  front matter stays); a document without a file becomes a new file at the
  path its title names; a synchronized file without a document is removed,
  except a folder's annotation `README.md`;
- images and other files a document embeds from Linear are downloaded next
  to it, named by their content's SHA-256 hash (`<hash>.png`), and linked
  relatively; a file the branch already holds with the same content is
  linked instead of copied. The repository's `.gitattributes` decides
  whether a file is stored in Git LFS, as for a person's commit. The
  `uploads` state ref records each file's Linear URL, so the sync does not
  upload it again;
- a link to another synchronized document's Linear URL becomes a relative
  link to its file, in the spelling the tracked file already had for it;
- the repository's security hooks (`alias: security`) check each document's
  text with the files it embeds before anything is pushed. A document they
  flag, or whose file cannot be downloaded, is listed: a new file is left
  out, and an existing file keeps the tracked branch's text;
- document ids go to `refs/mdbisync/ids` as the run goes, and at the end one
  push records `refs/mdbisync/linear` (one commit on top of the tracked
  branch, with the synchronized folders as Linear holds them), `ids`,
  `uploads` and the sync branch, which points at the same commit;
- it opens a pull request from the sync branch to the tracked branch.

**A person reviews and merges that pull request**, with a merge commit: it can
remove files (they stay in the history). The sync never merges it, and `sync`
refuses to run until it is merged. A run that stops early exits with code 5;
run it again with the same inputs to go on without duplicate files.

### File names for titles

A document's title stays as it is in Linear; its file name is made from it
by one rule, the same in the initial sync and in the sync:

- each `/`-separated part of the title is a folder or the file name;
- `%`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` and control characters are
  percent-encoded (`Q3: plans?` becomes `Q3%3A plans%3F.md`), and so are
  dots and spaces at the end of a part (`notes.` becomes `notes%2E.md`);
- an empty part (a leading `/` or `//`) becomes `%00`; `.`, `..`, `.git` and
  names Windows reserves (`CON`, `NUL`, `COM1`, …) get their first character
  encoded (`%2E%2E`, `%43ON`); spaces at the start of a part are kept;
- a part longer than 180 bytes is cut to 40 characters plus `~` and 16
  characters of its SHA-256 hash;
- a name that would land on another file (also one differing only in letter
  case), or in a folder another annotation owns, becomes one file in the
  folder of the document's team or project: the encoded title with `/` as
  `%2F`, then `~` and 12
  characters of the SHA-256 hash of the document's id
  (`notes%2Fstray~1a2b3c4d5e6f.md`).

The `ids` state ref ties the file to its document, so the sync does not
rename the document after its file name.

## The sync pull request

Linear's changes reach the tracked branch only through one pull request from
the sync branch (`mdbisync/linear` by default), which the sync opens and
merges itself, acting as the deployer's GitHub App so that CI runs on it.

- A run opens the pull request when merging Linear's state would change the
  tracked branch. Changes made in git alone open none.
- Later Linear changes join the open pull request's branch by fast-forward or
  merge commit; the branch is never force-pushed. The branch moves only when
  Linear brings something new, so the checks on its head are not restarted by
  every run.
- After opening the pull request or moving its branch, a run waits up to
  `merge-grace-seconds` (default `60`, range `0`–`120`) for the head's check
  runs and commit statuses. When every check has finished and passed, it
  merges with a merge commit in the same run after at least 15 seconds for
  CI registration. With no checks, it waits for 15 seconds of continuously
  absent checks to allow CI to register first.
  Checks still running at the deadline leave the merge to a later run.
  Grace periods of 15 seconds or less defer merging because they leave no
  time for a check observation after registration settles.
  Set `merge-grace-seconds: 0` to always defer a new head's merge to a later
  run. The CLI uses `MDBISYNC_MERGE_GRACE_SECONDS`. Later runs read an
  unchanged head's checks once, without waiting. A moved head cannot merge
  using the old head's checks.
- A check that fails is a setup error: the run summary names it, the run
  exits with code 3, and the pull request stays open until the repository's
  checks pass Linear's form. Tracked-branch changes are not written to Linear
  until then. Fix the check configuration or rerun the failed check on the
  sync pull request; changing a file on the tracked branch alone does not
  rerun that check.
- After the merge, the next run finds nothing to write and opens no pull
  request.
- While the open pull request of an initial sync from Linear waits for a
  person, `sync` adds nothing to its branch and writes nothing to Linear. A
  closed initial-sync pull request leaves its snapshot behind, including
  review commits on top of it. The next sync pull request carries the tracked
  branch with Linear's state merged in.
- Closing an ordinary sync pull request opens a replacement from the same
  branch on the next run. Pending person edits and CI fixes are kept and new
  captures are merged into them, without force pushes.
- A pending edit on the sync branch that changes the same lines as a later
  Linear edit or tracked-branch edit is not dropped and does not hold the
  pull request. The next run merges the two into the sync branch with a
  merge commit, both versions between the usual conflict marker paragraphs
  (the sync branch's edit is the git version against Linear, the Linear
  version against the tracked branch). The pull request carries the markers
  to the tracked branch and from there to Linear, like any other conflict,
  and the run summary names the documents. Front matter changes from both
  sides are kept unless they change the same lines, where the git version's
  wins. A pending delete or rename that meets an edit follows the usual
  structural conflict rules (an edited document is kept), and the summary
  names it too. Resolve a conflict by editing the text on
  either side, or on the sync branch before the merge; a merge of your own
  on the sync branch is kept as it is. Only a conflicting file that is not a
  synchronized document, which cannot hold markers, still waits for you to
  merge the tracked branch into the sync branch.

## Pre-release builds and pins

Maintainers dispatch **Build pre-release** on `main`, supplying a new
pre-release tag such as `v0.1.0-rc.1` and a full source SHA already on `main`.
The workflow tests and bundles that source, verifies the CLI can install
offline, and pushes a new annotated tag pointing to an isolated release
commit. Its summary prints the release SHA. No generated files are added to
`main`, no existing tag is replaced, and no GitHub Release is published.
A failed build leaves existing pins unchanged.

Use the **release commit SHA**, which differs from the source SHA, in both
configuration files. Replace the placeholder with the summary's 40-character
release SHA and keep its version comment:

```yaml
# In a GitHub Actions workflow:
- uses: mdbisync/mdbisync@<release-sha> # v0.1.0-rc.1
```

```yaml
# In .pre-commit-config.yaml:
repos:
  - repo: https://github.com/mdbisync/mdbisync
    rev: <release-sha> # v0.1.0-rc.1
    hooks:
      - id: linear-format
```

The action runs its checked-in JavaScript bundles without installation.
The hooks use Node 24 and npm already installed on your machine
(`language_version: system`); no Node toolchain or registry dependencies are
downloaded when installing or running them. Use npm 11.16.0 or newer: npm
11.12.1 rejects pre-commit's local Git package installation. The release
package contains only bundled code and has no install scripts.

`linear-format` fixes Markdown into Linear's form and exits 1 when it changes
a file; a second run passes. `linear-format-check` reports changes without
writing them. Both refuse constructs Linear would lose, with a file, line and
rule, leaving the file unchanged. Every rule, what `fix` changes, and the CI
workflow that commits the fixes to pull requests ([examples/pre-commit.yml](../examples/pre-commit.yml))
are described in [linear-format.md](linear-format.md).

Enable Dependabot's
`github-actions` ecosystem in your repository to propose action SHA updates,
then copy the proposed release SHA into the hook's `rev` in the same change.
To update to a specific pre-release, resolve its annotated tag and use the
first column as both pins:

```sh
git ls-remote https://github.com/mdbisync/mdbisync 'refs/tags/v0.1.0-rc.2^{}'
```

`pre-commit autoupdate` follows source history and cannot discover these
isolated release commits. Keep the hook on an explicitly resolved release
SHA.

The action's bundles include third-party packages under their own licenses;
every release commit ships their license texts and notices in
`dist/THIRD_PARTY_NOTICES.txt`.
