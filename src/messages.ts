// Every fixed text a run can print when it fails, stops or warns: errors,
// a run's last line and a setup check's failed or warning detail. A text
// names its variable parts in braces, such as `{path}`, and `message`
// fills them in. docs/troubleshooting.md explains each text; its test reads
// this table, so a new text cannot ship without its explanation.
//
// Out of scope, as for the page: `src/release/` and `src/test-hooks.ts`,
// which users never run, and `src/format/` (`lint` and `fix`), which has its
// own page.

export const MESSAGES = {
  // The command line and the action.
  'cli.missing-command': 'missing command',
  'cli.unknown-command': 'unknown command: {command}',
  'cli.node-too-old': 'mdbisync requires Node 24 or newer; install it before running the hook.',
  'cli.not-implemented': '{command}: not implemented',
  'action.unknown-operation': 'unknown operation: {operation} (expected one of: {operations})',
  'action.unknown-security-step': 'unknown security-step: {step} (expected one of: {steps}, or empty)',
  'action.cleanup-before-stage': 'cleanup-tokens belongs before the stage step, not apply',
  'action.cleanup-revocation-failed': 'token cleanup revocation failed',

  // `init`.
  'init.security-twice': 'choose security hooks once',
  'init.unknown-option': 'unknown option: {option}',
  'init.needs-value': '{option} needs a value',
  'init.must-follow-folder': '{option} must follow --folder',
  'init.given-twice-for-folder': '{option} was given twice for a folder',
  'init.given-twice': '{option} was given twice',
  'init.path-outside': 'paths must stay inside the repository',
  'init.symlink': 'setup destinations must not contain symlinks',
  'init.folder-is-file': 'a setup folder path names a regular file',
  'init.invalid-yaml': 'invalid YAML configuration',
  'init.readme-differs': '{folder}/README.md already has a different {key}',
  'init.needs-repos': '{file} needs a repos list',
  'init.invalid-repository-entry': 'invalid pre-commit repository entry',
  'init.format-hook-differs': 'existing linear-format hook uses a different repository or release',
  'init.security-hook-differs': 'existing {hook} hook differs from the security example; reconcile it first',
  'init.release-sha': '--release-sha must be a full 40-character commit SHA',
  'init.release-version': '--release-version must be a version such as v1.2.3',
  'init.needs-folder': 'provide --folder with --team and/or --project',
  'init.not-at-root': 'run init at the repository root',
  'init.conflicting-folders': 'conflicting folder options: {path}',
  'init.workflow-differs': 'existing workflow differs: {name}',

  // The action's inputs and the run's operation.
  'inputs.required': 'the input {name} is required',
  'inputs.repository': 'the input repository must be "owner/name" (it defaults to the workflow\'s repository)',
  'inputs.document-cap': 'the input document-cap must be a positive safe integer',
  'inputs.merge-grace': 'the input merge-grace-seconds must be an integer from 0 to 120',
  'inputs.direction': 'the input direction {problem} (initial sync never picks a direction itself)',
  'inputs.direction-missing': 'is required',
  'inputs.direction-unknown': 'must be one of {directions}, not "{direction}"',
  'operation.initial-sync-inputs': 'the direction and confirm inputs belong to an initial sync, and only to it',

  // How a run ends.
  'run.partial': 'partial, will continue',
  'run.container-cap': '{command}: stopped before any write (container-cap); reduce additions or check document-cap',
  'run.stopped-before-write': '{command}: stopped before any write ({code}){detail}',
  'run.stopped-detail': ': {detail}',
  'run.how-to-fix': '{message}. How to fix it: {url}',
  'run.stopped-by-linear': '{command}: stopped by Linear before any write; run it again once the limit has reset',
  'run.not-finished-sync-branch': '{command}: not finished ({code}); merge or close the pull request of the sync branch and delete the branch, then run it again',
  'run.not-finished': '{command}: not finished ({code}); run it again with the same inputs',
  'run.revoke-failed': "the run's Linear token could not be revoked: {reason}",
  'run.container-not-read': 'container documents were not read',
  'pull-request.merge-blocked': 'setup error ({code}): GitHub refuses again to merge the sync pull request ({refusal})',
  'pull-request.initial-pending': 'stopped short ({code}): an initial sync from Linear waits for a person to merge it',
  'pull-request.not-finished': 'not finished ({code}); run it again',

  // The setup check.
  'setup.left-out': '{count} files left out, not synced: {files}{more}',
  'setup.left-out-more': ', and {count} more',
  'setup.no-annotations': 'no folder has linear-team or linear-project in its README.md front matter',
  'setup.github-rate-limited': 'GitHub rate-limited the setup check while reading the repository (HTTP 403); run again later',
  'setup.github-rate-limited-permission': 'GitHub rate-limited the setup check while checking {permission} (HTTP 403); run again later',
  'setup.github-refused': 'the GitHub token was refused (HTTP {status})',
  'setup.github-cannot-see': 'the GitHub token cannot see the repository (HTTP {status})',
  'setup.github-answered-permission': 'GitHub answered HTTP {status} while checking {permission}',
  'setup.github-reading-repository': 'reading the repository',
  'setup.github-lacks': 'the GitHub token lacks {permissions}{unchecked}',
  'setup.github-lacks-unchecked': ' ({permissions} not checked without it)',
  'setup.merge-commits-unknown': 'GitHub did not show whether merge commits are allowed',
  'setup.merge-commits-off': 'merge commits are not allowed in the repository settings',
  'setup.security-hooks-missing': 'no pre-commit hook marked "alias: {alias}": content is pushed unchecked',
  'setup.hooks-invalid-yaml': '{file} is not valid YAML',
  'setup.hooks-no-repos': '{file} has no "repos" list',
  'setup.format-hook-missing': '{file} has no {hook} hook',
  'setup.linear-refused-credentials': 'Linear refused the OAuth app client credentials',
  'setup.linear-refused-teams': 'Linear refused the token while reading teams',
  'setup.linear-scope': 'the Linear token lacks the scope {scopes}',
  'setup.too-many-projects': 'more than 250 Linear projects share the annotated names',
  'setup.no-team-visible': 'the Linear app saw no team in two lookups, so none of the annotated teams ({teams}) can be found: check the app\'s team access in Linear',
  'setup.target-not-found': 'not found in Linear: {targets}',
  'setup.target-ambiguous': 'more than one match in Linear: {targets}',
  'setup.target-shared': 'more than one folder maps to {targets}',
  'setup.initial-sync-unfinished': 'An initial sync stopped before it finished: run it again with the same inputs first. The sync wrote nothing.',
  'setup.initial-sync-required': '{ref} does not exist: run initial sync first. The sync wrote nothing.',
  'setup.initial-pull-request-pending': 'The pull request of the initial sync from Linear is not merged into {tracked} yet: a person reviews and merges it with a merge commit (it can remove files), then the sync runs. Closing the pull request or deleting its branch does not cancel this unmerged snapshot. To start over instead, close that pull request, delete the branch {sync} and run initial sync again to replace the snapshot. The sync wrote nothing.',

  // Annotations and the mapping.
  'annotations.invalid-yaml': '{readme}: the front matter with {teamKey} or {projectKey} is not valid YAML',
  'annotations.empty-name': '{readme}: {key} must be a non-empty name',
  'annotations.nested-team': '{readme}: names a team inside the folder of team "{team}" ({folder})',
  'annotations.nested-project': '{readme}: names a project inside the folder of project "{project}" ({folder})',
  'annotations.project-without-team': '{readme}: names a project, but neither it nor a folder above names a team',
  'mapping.content-not-read': 'the content of {path} was not read',

  // State refs and their files.
  'config.invalid-remote': 'remote "{remote}" is not a valid remote name',
  'config.invalid-branch': '{key} "{branch}" is not a valid branch name: {problem}',
  'config.starts-with-dash': 'starts with "-"',
  'config.same-branches': 'the tracked branch and the sync branch must differ',
  'config.nested-branches': 'one of the tracked branch and the sync branch is a folder of the other',
  'config.invalid-prefix': 'refPrefix "{prefix}" is not a valid ref prefix: {problem}',
  'config.prefix-outside-refs': 'refPrefix "{prefix}" must start with "refs/" and name a folder under it',
  'config.prefix-reserved': 'refPrefix "{prefix}" must not be under refs/heads, refs/tags or refs/remotes',
  'git.failed': 'git {args} failed with exit code {code}: {stderr}',
  'objects.missing': 'git object {oid} is missing',
  'objects.not-blob': 'git object {oid} is a {type}, not a blob',
  'objects.invalid-path': 'invalid repository path {path}',
  'state.tracked-missing': 'the tracked branch "{branch}" does not exist on remote "{remote}"',
  'state.not-fast-forward': 'refusing to move {ref} to a commit that does not descend from its current value',
  'state.same-ref-twice': 'a push names the same ref twice',
  'state.invalid-path-entry': '{file} has an invalid entry for a path',
  'state.invalid-entry': '{file} has an invalid entry',
  'state.file-missing': '{file} is missing in state commit {commit}',
  'state.invalid-json': '{file} in {commit} is not valid JSON',
  'state.not-object': '{file} in {commit} is not a JSON object',

  // Linear and its storage.
  'linear.cleanup-not-exclusive': 'token cleanup requires exclusive use of the Linear app',
  'linear.comment-mismatch': 'Comment identity does not match its document',
  'linear.updated-comment-mismatch': 'Updated comment identity does not match',
  'linear.created-comment-mismatch': 'Created comment identity does not match',
  'linear.no-upload-target': '{operation}: Linear returned no upload target',
  'linear.storage-failed': '{operation}: storage request failed',
  'linear.storage-answered': '{operation}: storage answered HTTP {status}',
  'linear.page-without-cursor': '{operation}: Linear reported another page without a cursor',
  'linear.not-success': '{operation}: Linear reported success: false',
  'linear.stopped': '{operation}: Linear client stopped ({reason})',
  'linear.rate-limited': 'rate limited',
  'linear.rate-limited-retry': 'rate limited, retry after {seconds} s',
  'linear.budget-low': '{header} is {remaining}, below {threshold}',
  'linear.error': '{operation}: Linear error {code} (HTTP {status}, request {request}): {detail}',
  'linear.answered': '{operation}: Linear answered HTTP {status} (request {request})',
  'linear.request-failed': '{operation}: request to Linear failed ({cause})',
  'linear.too-long': '{operation}: {field} is {length} characters, Linear accepts at most {limit}',
  'linear.read-back-failed': '{operation}: written, but reading back the stored record failed',
  'linear.token-refused': 'oauth.token: Linear refused the token request ({reason})',
  'linear.revoke-unconfirmed': 'oauth.revoke: Linear did not confirm the revocation (HTTP {status})',
  'linear.token-request-failed': '{operation}: request to Linear failed',
  'linear.upload-not-allowed': 'upload destination is not allowed',
  'linear.not-in-upload-cache': 'a linked file is not in the upload cache',

  // GitHub's pull request API.
  'github.no-answer': 'GitHub did not answer while {action}',
  'github.answered': 'GitHub answered HTTP {status} while {action}',
  'github.listing': 'listing open pull requests',
  'github.opening': 'opening a pull request',
  'github.updating': 'updating a pull request',
  'github.closing': 'closing a pull request',
  'github.sending': 'sending {method} to the pull request API',
  'github.reading-check-runs': 'reading the check runs of the sync pull request',
  'github.reading-statuses': 'reading the commit statuses of the sync pull request',
  'github.merging': 'merging the sync pull request',

  // Initial sync.
  'initial-sync.state-moved': 'a state ref moved while the run was writing',
  'initial-sync.document-not-listed': 'the planned document for {path} was not listed',
  'initial-sync.links-not-prepared': 'document-links: apply before prepare',
  'initial-sync.project-not-resolved': 'project "{project}" of team "{team}" was not resolved',
  'initial-sync.team-not-resolved': 'team "{team}" was not resolved',
  'initial-sync.text-not-read': 'the text of {path} was not read',
  'initial-sync.misplaced': 'the recorded tree maps {count} files to other documents',
  'initial-sync.over-upload-limit': '{files}: over the upload limit of {limit} bytes',
  'initial-sync.lfs-extensions': '{files}: stored with LFS extensions, which are not supported',
  'initial-sync.upload-unreadable': '{file} cannot be read: {reason}',
  'initial-sync.uploads-not-prepared': 'the uploads transform was not prepared',

  // The sync.
  'sync.needs-initial-sync': 'run initial sync first',
  'sync.places-unresolved': 'the previously recorded document places could not be resolved',
  'sync.lost-lease': 'state moved while recording document marks',
  'sync.no-lfs-pointer': 'LFS did not return a pointer',
  'sync.entry-mismatch': 'Document and id entry do not match',
  'sync.needs-content': 'Status reconciliation requires document content',
  'sync.needs-comment-target': 'A marked document requires a comment target',
  'sync.no-merge-tree': 'git merge-tree gave no tree',
  'sync.no-safe-path': 'no safe destination for a document',
  'sync.invalid-update-time': 'a document has an invalid update time',
  'sync.invalid-security-config': 'invalid security hook configuration',
  'sync.needs-pre-commit': 'security hooks require pre-commit on PATH; install pre-commit before capture',
  'sync.no-runner-temp': 'RUNNER_TEMP is not set; the staged security steps run in a GitHub Actions job',
  'sync.staged-version': 'the staged candidates come from another version of the action',
  'sync.staged-hash': 'the staged manifest names a file that is not a content hash',
  'sync.write-before-record': 'the sync writes to Linear only after initial sync has recorded `linear`',
  'sync.merge-conflict-output': 'Invalid merge-file conflict output',
  'assets.not-allowed': 'asset destination is not allowed',
  'assets.redirect-not-allowed': 'asset redirect destination is not allowed',
  'assets.download-failed': 'asset could not be downloaded',
  'assets.too-large': 'asset exceeds the download limit',
  'assets.destination-exists': 'asset destination already exists',
} as const;

export type MessageKey = keyof typeof MESSAGES;

/** The names in braces of a text: `{path} was not read` has `path`. */
type Slots<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}` ? Name | Slots<Rest> : never;

type Values<Key extends MessageKey> = Record<Slots<(typeof MESSAGES)[Key]>, string | number>;

/** The text of `key` with its slots filled in; a text without slots takes no values. */
export function message<Key extends MessageKey>(key: Key, ...values: [Slots<(typeof MESSAGES)[Key]>] extends [never] ? [] : [Values<Key>]): string {
  const filled = values[0] as Record<string, string | number> | undefined;
  return MESSAGES[key].replace(/\{(\w+)\}/g, (_, name: string) => String(filled?.[name]));
}
