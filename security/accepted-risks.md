# Accepted risks

Known risks that the project has accepted instead of closing. The security
report of each final release lists every entry below in its "Accepted risks"
section. Each entry gives the risk, why it is accepted and what you can do
about it. A finding behind an accepted risk is reported here, never as fixed.

## A hostile security hook can affect the sync's later steps

**The risk.** The sync runs your repository's own security hooks (the
pre-commit hooks you mark `alias: security`) in a step between two steps that
hold the Linear and GitHub credentials. The hooks step holds none of those
credentials, but it shares the runner's disk and processes with the other
steps. A hook written to attack the runner can change what a later step does,
for example make it push content the hooks did not check, or run its own
program beside the credentials.

**Why it is accepted.** The hooks are your repository's own configuration,
chosen by whoever controls that repository. Someone who can make your hooks
malicious already controls your repository; the sync adds no new attacker.
No boundary inside one job can stop it, and moving the hooks to a separate
job would send your Linear content through GitHub as an artifact.

**What you can do.** Use only hooks you trust, review changes to your
pre-commit configuration like any other code, and protect it with the same
branch rules as the rest of your repository.

## A sync pull request retargeted in the moment before its merge

**The risk.** GitHub's merge API checks only the head commit of a pull
request, not the branch it merges into. Someone with write access who changes
the base branch of a sync pull request, or pushes to the tracked branch, in
the short moment between the sync's last check and the merge can make the
checked change land on a branch or a commit the sync did not check.

**Why it is accepted.** It needs a person with write access and exact
timing. The same race exists for a maintainer who merges a pull request by
hand. Closing it fully would require letting the sync's GitHub App push
straight to the default branch past its rules, which many organizations do
not allow.

**What you can do.** Give the App a bypass only on the ruleset of the tracked
branch, and keep your other protected branches under their own rules, so a
retargeted pull request still meets the rules of the branch it now targets.
Limit write access to people you trust.

## A workflow in the repository can post a passing check on a sync pull request

**The risk.** Every GitHub Actions workflow in a repository publishes its
check runs as the same GitHub Actions App. A workflow or action that runs in
your repository with permission to create check runs, from any branch, can
post a passing check under any name on a sync pull request's head, also one
that takes the place of a failed check of the same name. The sync counts a
check by its name and publisher, so such a check can let a sync pull request
merge before your real CI has passed on that head, or after it failed.

**Why it is accepted.** A workflow that can do this can post a passing check
on any pull request in the repository, not only the sync's, so the
repository's own workflows already decide what its checks mean. When security
hooks are configured, they still check the content from Linear inside the
sync's own job before anything is pushed. Telling one workflow's checks from
another's would need the sync's GitHub App to read the repository's Actions
runs, a further permission for every installation.

**What you can do.** Set the repository's default workflow permissions to
read-only, give each workflow only the `permissions:` it needs
(`checks: write` only where a job must create check runs), run only workflows
and actions you trust, pin third-party actions to full commit hashes, and
review changes to `.github/workflows/` on every branch like any other code.
Limit who may push branches, since a workflow on any branch runs with the
repository's token.

## AR-005: A Linear edit saved between the final read and write

**Accepted.** 2026-11-19.

**The risk.** An edit saved in Linear after the sync's final read of a
document and before its update or trash mutation takes effect can be
overwritten or lost.

**Why it is accepted.** Incremental sync and confirmed initial sync reread
each existing document by ID immediately before writing it. Linear's
`documentUpdate` and `documentDelete` mutations take no version condition,
so the check and mutation cannot be atomic.

**What you can do.** For a critical edit, stop ongoing sync, wait for the
active run to finish, save the edit, then enable sync again.

## AR-006: A document edit pushed to the sync branch merges without review

**Accepted.** 2026-11-26.

**The risk.** When the sync's GitHub App may bypass required reviews on the
tracked branch and other people with write access may push to the sync
branch `mdbisync/linear` or the suspended branch `mdbisync/suspended`,
someone can push a commit there that changes only synchronized documents or
their assets. The sync's scope check accepts it, and the sync merges it once
its checks pass, without the review the tracked branch otherwise requires.
Both lanes do this: the sync pull request and the suspended pull request.
Such a commit does not pass the hooks you mark `alias: security`: the sync
runs them only on content it captures from Linear. So a secret, or other
content those hooks would reject, can reach your tracked documents, and
after the merge the sync writes it to Linear as well. Code, workflows and
configuration cannot enter this way: a change to any other file, to a
file's mode, to anything under a `.github` folder or to a folder's Linear
annotation leaves the pull request to a person.

**Why it is accepted.** It is a property of the design. The App merges
document-only changes so that the sync runs unattended, and updates to the
sync branches stay open where the `pre-commit` workflow must push its
formatter fixes. The risk needs write access to the repository and a
bypass for the App on the tracked branch. It can bring in only document
content, about what any member of the Linear team can already change through
Linear, and CI still runs on it: the `pre-commit` workflow, when you use it,
runs your whole configuration on the pull request, including security hooks
in its stage, though a commit pushed to a sync branch is on GitHub before
any check runs.

**What you can do.**

1. Keep the sync branches to the sync. Add the ruleset from
   [who may push to the sync branches](https://github.com/mdbisync/mdbisync/blob/main/docs/quickstart.md#who-may-push-to-the-sync-branches)
   with **Restrict creations**, **Restrict updates** and **Restrict
   deletions**, and the sync's App as its only bypass actor. The trade-off:
   with updates restricted, GitHub refuses the push of the `pre-commit`
   workflow's fixes, so its `pre-commit fixes` job and the `pre-commit`
   check fail whenever your hooks would change a document, and the sync does
   not merge that document until it passes. If you rely on those fixes,
   leave **Restrict updates** off and keep the other two; a person who can
   push can then still add a document edit to a sync pull request.
2. Limit write access to the repository to people you trust.
3. Review the sync's merged pull requests and the history of the sync
   branches for commits the sync did not make.
