# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go straight to
[the reporting form](https://github.com/mdbisync/mdbisync/security/advisories/new).
Do not open a public issue, pull request or discussion for a suspected
vulnerability.

Include what an attacker could do, the affected version or release commit,
and the steps or a minimal configuration that reproduces it. Leave real
tokens, keys and workspace content out of the report; a redacted example is
enough. If a real token was exposed, revoke it first.

Before you report, check [the accepted risks](security/accepted-risks.md):
they are known and documented, so a report about one of them is answered
with a link to its entry. A new way to exploit one, or a cheaper way to
close it, is still welcome.

## How reports are handled

mdbisync is a small project, so the times below are goals, not guarantees.

1. **Acknowledge.** We confirm that we received the report, usually within
   a week.
2. **Assess.** We reproduce the problem, rate its severity and tell you
   whether we will fix it. We aim to do this within two weeks of
   the report.
3. **Fix.** We prepare the fix in the advisory's temporary private fork and
   release it as soon as it is ready and tested. You can review the fix
   before the release if you want to.
4. **Disclose.** With the release, we publish the GitHub security advisory,
   with a CVE when the problem warrants one, and credit you unless you ask
   us not to.

Please keep the problem private until the advisory is published. If a fix
takes longer than 90 days, we agree a disclosure date with you.

## Supported versions

mdbisync is in early development and has published pre-releases
(`v0.1.0-rc.*`) only; `v0.1.0` will be the first final release.

| Version | Security fixes |
| --- | --- |
| The newest final release; until `v0.1.0`, the newest pre-release | Yes |
| Older releases and other pre-releases | No; update to the supported release |

Fixes go into the next release and are not backported. Pin your workflows
and hooks to the newest release commit to receive them. Some fixes change
the workflow templates in `examples/` rather than the action: compare the
workflows you copied with the newest templates and apply their changes,
keeping your own settings.

Each final release carries a security report; see
[security/reports](security/reports/README.md).

## Scope

In scope: the action, its pre-commit hooks and command line, the release
bundles, the workflow templates in `examples/` that `init` writes, and how
they handle Linear and GitHub tokens and repository content. Out of scope:
Linear and GitHub themselves, and vulnerabilities in third-party packages
that mdbisync does not bundle or that cannot be reached through it.
