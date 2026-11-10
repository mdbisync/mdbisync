# Test base

mdbisync is tested from the outside in: every behavior the sync promises is
a scenario with an id (`L1-04`, `L3-02`), and a harness runs the scenarios
against a real Git repository and a real Linear workspace. A scenario is
written before the code that makes it pass, so most of them start red.

This page explains how to build the test corpus, run scenarios, read their
reports, and which credentials a live run needs. Unit tests and the
general setup are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## What is here

| Path | What |
| --- | --- |
| `fixtures/` | The fixture bank: one small file per Markdown construct and edge case, with Linear's recorded form beside it ([fixtures/README.md](fixtures/README.md)) |
| `probe/` | The format probe that records Linear's form of every fixture ([probe/README.md](probe/README.md)) |
| `corpus/` | The corpus generator: a deterministic, seeded repository tree of about 2,900 files built from the bank |
| `scenarios/` | One spec per scenario id (`L0-01.yaml` and so on): slice, mode, setup, steps and checks; the spec format, step kinds and invariants are in [scenarios/README.md](scenarios/README.md) |
| `e2e/harness/` | The harness: isolation, steps, checks, reports and cleanup |
| `e2e/expected-red.json` | Scenarios whose feature has not landed yet |

Levels go from simple to complex: L0 Markdown format (mostly offline), L1
initial sync from Git to Linear, L1R initial sync from Linear to Git, L2
changes on one side, L3 conflicts, L4 concurrency, L5 errors and recovery,
L6 checks in the Linear UI.

## Prerequisites

Node 24, Git and [pre-commit](https://pre-commit.com/), then from the
repository root:

```sh
npm ci
npm run build
```

Scenarios that commit as a person go through released pre-commit hooks,
which need npm 11.16.0 or newer.

## Build the corpus

The generator needs no network and no account. It writes `corpus/` (the
tree) and `corpus-slices/` (one file list per slice and a manifest that
describes every file) under its output folder:

```sh
node test/corpus/generate.ts --hook-rev <40-character-release-sha> --out test/corpus/out
node test/corpus/check.ts test/corpus/out --lint
```

- `--hook-rev` is the release commit of the Linear-format hook that the
  corpus's `.pre-commit-config.yaml` pins (see
  [Pre-release builds and pins](../docs/usage.md#pre-release-builds-and-pins)).
  To look at the corpus only, any 40-character hex string works.
- `--seed` changes the generated text; the same seed always gives the same
  bytes. `--replace` overwrites an existing output folder.
- `check.ts` checks the tree against the manifest and the composition
  rules. With `--lint`, the files the linter reports must be exactly the
  manifest's lint-error files, and every other synchronized Markdown file
  must already be in Linear's form. With `--git`, run on a checkout made
  without LFS smudging, every LFS file must be a pointer.

The harness does not read a local corpus: live scenarios take their files
from `corpus/` and `corpus-slices/` on the `main` branch of the test
repository. To set one up, commit the generator's output there (with Git
LFS) and run `check.ts --git` on a fresh clone made without LFS smudging
(`GIT_LFS_SKIP_SMUDGE=1 git clone ...`).

A scenario uses one slice of the corpus:

| Slice | What |
| --- | --- |
| `mini` | a few documents in two teams and three projects, a team zone, two images (one in LFS), a PDF, front matter |
| `bank` | every fixture of the bank |
| `mid` | about 300 files across every group of the corpus, always with the documents `MID_REGRESSIONS` in `test/corpus/slices.ts` pins for the seed |
| `full` | the whole corpus |

## Run scenarios

The harness's command line is `test/e2e/harness/cli.ts`. Select scenarios
by id, level, slice or mode; filters combine.

```sh
node test/e2e/harness/cli.ts plan --levels L1 --slices mini   # what would run, with request estimates
node test/e2e/harness/cli.ts run  --levels L1 --slices mini   # run them
node test/e2e/harness/cli.ts run  --ids L1-04,L2-01 --workers 2
node test/e2e/harness/cli.ts checklist --ids L6-05            # print a UI scenario's checklist
node test/e2e/harness/cli.ts ui-result <run folder> <checklist>  # take up a held UI run with its answers
node test/e2e/harness/cli.ts sweep                            # remove leftovers of dead or old runs
```

| Option | Meaning |
| --- | --- |
| `--ids`, `--levels`, `--slices`, `--modes` | comma-separated filters; modes are `local` (the command line), `actions` (the workflows in the test repository) and `ui` (a checklist for a person or a browser session) |
| `--teams` | optional comma-separated team keys for a partial-corpus run; supported for compatible targeted scenarios only, refused for `full`; results do not replace catalog status |
| `--workers` | scenarios at once (default 4); the budget governor still holds back scenarios that Linear's hourly budget cannot cover |
| `--out` | the report folder (default `test/e2e/out/<harness run id>/`) |
| `--defer` | ids to report as skipped instead of running them |
| `--status-page` | a Markdown file to update with each scenario's latest result |
| `--evidence-dir` | a folder for a content-free summary of the run |

`Ctrl-C` lets the running scenarios finish with their cleanup and skips the
rest; a second `Ctrl-C` stops at once and keeps shared reservations for
verified recovery.
`run` exits with 1 when a scenario or its cleanup fails and 0 otherwise, even when
scenarios are env-blocked or expected-red. Any command also exits with 1
when the harness itself stops with an error, 2 for an unknown command and
130 after a second `Ctrl-C`.

### Without credentials

With no test configuration, the L0 format scenarios that need neither
Linear nor the test repository (L0-01 to L0-04 and L0-07) run for real, and
every other scenario ends `env-blocked` with the missing item as its
reason; L0-08 is one of them, because it reads the corpus's hook
configuration from the test repository. This is the quickest way
to see that the harness works:

```sh
node test/e2e/harness/cli.ts run --levels L1 --slices mini
```

Each of the selected scenarios reports `env-blocked: no Linear app is
configured`. `--levels L0` runs the offline format checks and takes a few
minutes.

### Isolation and cleanup

Many runs can share one test repository and one Linear workspace. Each
scenario run gets a six-character run id and works only under names made
from it: branches `t/<run>/main` and `t/<run>/sync`, state refs under
`refs/mdbisync-t/<run>/`, Linear projects with neutral generated names, and
team-zone documents whose titles start with the run id. Live CLI runs reserve shared admission state on the sandbox branch
`scenario-control`. A run claims all teams in its selected corpus before
Linear writes; two runs claiming the same team never overlap. Claims stay
through cleanup. A `full` run excludes all other live runs, including runs
on other apps. App worker limits and request/complexity reservations are
shared across hosts, keyed by app identity rather than configuration labels.

Cleanup runs after every scenario, pass or fail, except a scenario held
for its UI steps, whose data stays for a person or a browser session until
the hold ends (the report's Cleanup column says so). Cleanup closes the run's pull
requests, deletes its branches and refs, and archives its Linear documents
by deleting their run projects. Before writes, the harness requires a readable
census of active and trashed team-zone documents and enough headroom for the
planned documents. Each selected team's trash count is read before and after;
an increased or unreadable after-count fails cleanup.

`sweep` reads shared admission state before touching any remote resource and
protects every registered run regardless of age or host. An unavailable or
malformed shared state stops sweeping and new admissions. The control branch
contains only counts, run identities and zone claims; never document content
or credentials. Its updates use ordinary fast-forward-only pushes, without
force, and retry competing updates after rereading state and app budget.

Reservations never expire automatically: failed cleanup, a UI hold or a killed
writer keeps its teams and app capacity reserved. To recover an abandoned
reservation, first prove its writer and any workflow/engine children stopped,
then recover its exact ownership record and verify refs, pull requests,
projects and documents cleaned up before releasing that reservation through
`SharedAdmission.release(runId, owner)`. Do not remove the control branch or
release a reservation merely because a heartbeat is old. Automatic sweeping
leaves these reservations alone; it continues to recover unreserved older
runs by its existing rules. Keep the owning run's state and output folders
until recovery succeeds.

Use one upgraded harness and the same sandbox URL for all cooperating
processes; older harnesses and custom drivers require an exclusive window.
For compatible scenarios that do not require both teams or cross-team links,
start separate processes with separate output/state directories, for example:

```sh
node test/e2e/harness/cli.ts run --ids L1-05 --teams ENG --workers 1 --out test/e2e/out/team-a
node test/e2e/harness/cli.ts run --ids L1-05 --teams DOCS --workers 1 --out test/e2e/out/team-b
```

Choose scenarios and teams present in their slice. Filtering preserves paths,
project-team inheritance and common unannotated assets; it does not repair a
scenario that needs an excluded fixture. Scoped reports explicitly identify
their teams and never replace the latest complete-corpus scenario status.

Each run also keeps an ownership record in the state folder
(`owned/<run>.jsonl`): every document id, project id and name, and team zone
it creates in Linear, written as each is created. The engine's writes are
recorded at the fault proxy and the harness's at its own clients; every
create carries its own id, so it is on record before Linear sees it, even
when Linear's answer is lost. Cleanup archives every recorded document, a
team zone's README without the run's prefix included. When cleanup fails (an
HTTP 503), the run stays registered, and `sweep` recovers it from its record,
not by name patterns; only team-zone documents with the run's prefix that the
record lacks (an engine that ran in Actions, outside the proxy) are added by
name. It first refuses, changing nothing, when the record names a project
that is not the run's (or no longer has its recorded name) or a live
document outside the run's projects and team zones. It never deletes a
project again that Linear already answered it deleted. It forgets the run
only after its refs, open pull requests and projects read back gone and
every document it created reads back archived and not trashed; a document a
scenario deleted for good, or trashed in a project already deleted, is
counted, not cleaned. The run's report keeps its failed cleanup.

Cache locks, ownership records and UI holds live in a state folder on the
host (`MDBISYNC_HARNESS_STATE_DIR`, default `<tmp>/mdbisync-harness`).
The live CLI uses the sandbox control branch for cross-host admission;
local-only governor instances are for offline tests and exclusive legacy
drivers. Shared control updates fail closed when Git access fails.

## Read a report

A run writes `report.md` and `report.json` in its report folder, and one
folder per scenario under `runs/<scenario>-<run id>/` with the harness log,
the engine's inputs and outputs, and the evidence the checks read.

```text
| pass | fail | expected-red | env-blocked | skipped |
| --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 8 | 0 |

| Scenario | Run | Result | Reason | Engine requests | Harness app reads | Seconds | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L1-01 | b9e23f | env-blocked | no Linear app is configured | 0 | 0 | 0 | ok |
```

| Result | Meaning |
| --- | --- |
| `pass` | every step ran and every check held |
| `fail` | a check failed or a step broke on a scenario that is not on the expected-red list, or the harness itself broke: its reason then starts with `harness:` (a step the harness cannot run yet) or `harness error:` (any other error of the harness) |
| `expected-red` | the scenario is on the expected-red list and failed for a product reason: the engine answered "not implemented", a product step failed, or a check did not hold |
| `env-blocked` | the environment could not run it: missing configuration, Linear budget, runner, corpus or browser; the reason says which |
| `skipped` | not run: deferred, or stopped before its turn |

The reason column lists the checks that did not hold, by name. `I1` to
`I9` are the invariants every scenario checks, defined in
[scenarios/README.md](scenarios/README.md); other names are the
scenario's own assertions (for example `fix.output (same-as did not
hold)`), defined in its spec under `checks.assertions`.

`Engine requests` counts what the engine sent through the harness's Linear
proxy; `Harness app reads` counts the harness's own reads through the OAuth
app; `Cleanup` says whether the run left nothing behind.

A scenario on the expected-red list that passes is marked as an unexpected
pass. The change that made it pass removes its id from
`e2e/expected-red.json`.

## Credentials for live runs

The live scenarios create and delete their own data. Use a Linear
workspace and a GitHub repository made for testing, never ones with real
work in them.

The harness reads its configuration from the environment and from
`secrets.env` (lines of `NAME=value`) in the test configuration folder
that `MDBISYNC_TEST_CONFIG_DIR` names (its default is in
`e2e/harness/config.ts`). The
environment wins. Values are never written to a report or a log.

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `LINEAR_TEST_APP_CLIENT_ID`, `LINEAR_TEST_APP_CLIENT_SECRET` | every live scenario | an OAuth application of the test workspace with client credentials and the `read` and `write` scopes; the harness mints a short-lived token and revokes it at the end |
| `LINEAR_TEST_APP_2_CLIENT_ID`, `..._SECRET` (up to `_9_`) | optional | more OAuth applications; each has its own hourly budget, and the governor spreads workers over them |
| `LINEAR_TEST_ALICE_API_KEY`, `LINEAR_TEST_BOB_API_KEY` | every live scenario | personal API keys of two members of the test workspace, who play the people editing in Linear |
| `MDBISYNC_TEST_SANDBOX_URL` | every live scenario | `https://github.com/<owner>/<repo>` of the test repository, which holds the corpus on `main` |
| `MDBISYNC_TEST_SANDBOX_GIT_URL` | optional | where Git reads and pushes instead, for example a local mirror |
| `SYNC_APP_CLIENT_ID` and the App's private key (`SYNC_APP_PRIVATE_KEY`, `SYNC_APP_PRIVATE_KEY_FILE`, or `sync-app.pem` in the configuration folder) | `actions` mode; optional for `local` | a GitHub App installed on the test repository; without it, local runs use your Git credential for the repository |
| `MDBISYNC_TEST_ACTION_SHA` | optional, `actions` mode; environment only, not read from `secrets.env` | a full release commit SHA the workflows run instead of the version their templates pin |
| `MDBISYNC_TEST_SCHEDULE_TICK` | optional, `actions` mode; environment only | `dispatch` starts the scheduled sync workflow by hand instead of waiting for GitHub's schedule (see below) |

The test workspace needs two teams with the keys `ENG` and `DOCS`; the
corpus's folders map to them. The free plan is enough, with two limits to
keep in mind: about 1,000 documents per team, counting trashed ones, and an
hourly API budget per OAuth application. The harness never trashes
documents to clean up (Linear keeps trashed documents for 30 days); it
archives them with their run project.

`actions` mode runs the workflows in the test repository itself, so that
repository needs its own settings; the local configuration is not
uploaded:

- the repository variable `SYNC_APP_CLIENT_ID` and the repository secrets
  `SYNC_APP_PRIVATE_KEY`, `LINEAR_TEST_APP_CLIENT_ID` and
  `LINEAR_TEST_APP_CLIENT_SECRET`, which the harness's copies of the
  workflows read;
- a self-hosted runner with the label `mdbisync-sandbox`: every job is
  rewritten to run on `[self-hosted, mdbisync-sandbox]`, so without such a
  runner the jobs stay queued;
- for the scenarios that need a scheduled run, the scheduled sync workflow
  on the repository's default branch. GitHub starts a schedule only from
  the default branch, and a run's branches never are, so that branch holds
  one scheduled workflow, rendered from the sync template: each tick it
  takes one run's request (the branch `t/<run>/schedule`, which it deletes)
  and runs the template's job on that run's branches, as a job named for
  the run. A tick without a request runs only that short request job.
  Install it once, and again when the template, the harness's rendering of
  it or `MDBISYNC_TEST_ACTION_SHA` changes, with `node test/e2e/harness/cli.ts scheduler --install`
  (without `--install` it prints the file). A run never changes the default
  branch: when the workflow there is missing, differs or is disabled, the
  scenario is env-blocked with that reason. GitHub may start a tick late or
  skip it; a request no tick takes within an hour blocks the run. Where
  GitHub starts no schedule at all, `MDBISYNC_TEST_SCHEDULE_TICK=dispatch`
  (environment only) makes the harness dispatch the workflow on the default
  branch right after the request, and again every five minutes while the
  request waits: a tick by hand that runs the same jobs and
  is recorded as `workflow_dispatch`, so a scenario that asserts the
  `schedule` event still fails.

`ui` mode is a checklist for a person or a browser session signed in as
the two members.

### UI sessions

A `ui` scenario runs its setup and every step before its first UI step,
then stops: the report says `env-blocked`, the run keeps its branches and
projects for two hours, and its run folder (`out/<harness run>/runs/<scenario>-<run>/`)
holds `ui-checklist.md` and `held-run.json`, which records where the run
stopped (no credentials). The UI session answers the checklist in the file:
`pass` or `fail` and what it saw for each item (never document content),
and a JSON value for each `ui.*` value the checks read. Then:

```sh
node test/e2e/harness/cli.ts ui-result <run folder> <answered checklist> --status-page <file> --evidence-dir <dir>
```

The harness goes on from where the run stopped. It runs the harness steps
between the answered items (such as `run.settle`); when it reaches an item
that is not answered yet, it saves the run and keeps the hold, so the
session answers the next items (and the values) only after that step ran, and
runs `ui-result` again; answers to items after a harness step that has not
run yet are refused. When a person resolves a conflict in the UI, the
harness reads the kept version and no longer expects the discarded edits
(I2). Once every item
is answered, it runs the checks, writes the result (pass, fail or
expected-red) over the run's `env-blocked` one in the harness run's report
and in the status page and evidence when given, cleans up and releases the
hold; the result is also kept as `ui-result.json` in the run folder, and
the status page keeps a newer result of the scenario from another run. A
`fail` ends the run at that item. A hold that has ended, a checklist of
another scenario or run, or missing values change nothing. A run that
holds a fault (armed proxy faults, a fault's engine environment or undo
steps) is not kept for the UI session: it is cleaned up and reported
`env-blocked`.

## Change the test base

- A new behavior gets a scenario spec in `scenarios/` and, until the code
  lands, an entry in `e2e/expected-red.json`; its id goes into
  `scenarios/catalog.json`. `npm test` checks every spec against the
  schema (`scenario-schema.test.ts`) and that the catalog and the specs
  name the same ids (`scenario-coverage.test.ts`).
- A new Markdown construct gets a fixture in the bank and its recorded
  Linear form from the probe; the generator picks it up for the corpus.
- A check that fails is a finding: fix the cause, never loosen the check
  to make a run green.
