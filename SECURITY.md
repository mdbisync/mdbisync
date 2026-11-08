# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, pull request or
discussion for a suspected vulnerability.

Include what an attacker could do, the affected version or release commit,
and the steps or a minimal configuration that reproduces it. Leave real
tokens, keys and workspace content out of the report; a redacted example is
enough.

## Supported versions

mdbisync is in early development. Fixes go into the next release; pin your
workflows and hooks to the newest release commit to receive them.

## Scope

In scope: the action, its pre-commit hook and command line, the release
bundles, and how they handle Linear and GitHub tokens and repository
content. Out of scope: Linear and GitHub themselves, and vulnerabilities in
third-party packages that mdbisync does not bundle or that cannot be
reached through it.
