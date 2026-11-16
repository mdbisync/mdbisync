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
