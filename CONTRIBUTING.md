# Contributing

Thank you for helping. Report security problems privately, as described in
[SECURITY.md](SECURITY.md), never in a public issue.

## Issues

Bug reports and feature requests are welcome in
[Issues](https://github.com/mdbisync/mdbisync/issues). A clear issue is the
most useful contribution: often it is all we need to make the change.

A bug report says:

- what happened, and what you expected instead;
- how to reproduce it: the command or workflow run, and a minimal Markdown
  file or Linear document that shows it;
- the version: the release or the release commit your workflows pin, and
  where it ran (the GitHub Action, a pre-commit hook or the command line);
- the run's output: its error lines and code, or its job summary.

A feature request says:

- the behavior you want, and how it works now;
- the workaround you use today to get that behavior, if there is one.

Never share your tokens, keys, real workspace content or contacts in an
issue; a redacted example is enough.

## Pull requests

Although an issue is often the faster and easier way to get your change,
pull requests are welcome too, and we will work through them with you.

A pull request keeps to one change, with tests that show it working, and
passes CI, code scanning and dependency review before it merges.

## Dependencies

mdbisync runs with access to your repository and your Linear workspace, so
adding a dependency is an exception: we avoid it and add one only when the
standard library is not enough. Such a dependency:

- is a well-maintained package under the MIT, ISC, BSD or Apache-2.0
  license, with no install scripts;
- is pinned to an exact version with its hash in `package-lock.json`;
- is never updated to a release less than 14 days old, unless that
  release fixes a known vulnerability with a real attack vector.

## License

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
