# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go straight to
[the reporting form](https://github.com/mdbisync/mdbisync/security/advisories/new).
Do not open a public issue, pull request or discussion for a suspected
vulnerability.

Include what an attacker could do, the affected version or release commit,
and the steps or a minimal configuration that reproduces it. Never share
real tokens, keys, workspace content or contacts in the report; a redacted
example is enough. If a real token was exposed, revoke it first.

Before you report, check [the accepted risks](security/accepted-risks.md):
they are known and documented, so a report about one of them is answered
with a link to its entry. A new way to exploit one, or a cheaper way to
close it, is still welcome.

Please keep the problem private until we release the fix and publish its
advisory.

## Supported versions

Reports are in scope for:

- every release from `v1.0.0` on, not only the latest;
- the latest commit on `main`.

Release candidates (`-rc` tags) are out of scope: they are not meant for
users to install, and we do not check them. If the problem is on the latest
`main`, report it now; there is no need to check older release candidates.

Fixes go into the next release and are not backported. To receive them,
update to it as described in
[Release builds and pins](docs/usage.md#release-builds-and-pins).

Each final release carries a security report; see
[security/reports](security/reports/README.md).

## Scope

**In scope:**
the action, its pre-commit hooks and command line, the release
bundles, the workflow templates in `examples/` that `init` writes, and how
they handle Linear and GitHub tokens and repository content. Vulnerabilities
in the third-party packages mdbisync bundles are in scope too, when they can
be reached through mdbisync.

**Out of scope:**
Linear and GitHub themselves, and vulnerabilities in third-party packages
that mdbisync does not bundle or that cannot be reached through it.
