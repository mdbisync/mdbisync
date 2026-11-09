# Conflicts

What happens when git and Linear change the same document between two sync
runs, what a conflict looks like on each side, and how to resolve it. Nothing
ever waits for you: every run finishes, every other document keeps syncing,
and no edit from either side is thrown away.

In this page, "git" means the tracked branch (usually `main`), and "the run
summary" is the summary of the sync workflow's run in the Actions tab
([the run summary](sync-cycle.md#the-run-summary)).

## How the two sides are merged

Each run merges the tracked branch's version of a document with Linear's
version, using git's three-way merge against the version both sides last
agreed on. The merge works line by line, and Linear keeps each paragraph on
one line, so:

- edits of **different paragraphs** merge cleanly and reach both sides in the
  same run, even when the paragraphs are next to each other;
- edits of **the same paragraph** become a conflict.

YAML front matter exists only in git: Linear never sees it. A conflict never
touches it, and front matter changed in git is kept whether the conflict is
resolved in git or in Linear.

## The conflict markers

A conflict is written into the document itself, as three marker paragraphs
around the two versions:

| Marker paragraph | What follows it |
| --- | --- |
| `**Sync conflict: git version**` | the tracked branch's version |
| `**Sync conflict: Linear version**` | Linear's version |
| `**Sync conflict: end**` | the rest of the document |

They are ordinary bold paragraphs, so Linear shows them as text and keeps
them exactly. The same text is in Linear and in the file on the tracked
branch: the sync pull request carries it there like any other change. Git's
own `<<<<<<<` lines are never used; Linear would turn them into quotes and
headings.

A document is in conflict exactly when one of its lines is one of these
marker lines, character for character, with nothing before or after it on
the line. Marker lines inside a code block, an inline code span, a quote or
an HTML block are only examples, like the ones on this page, and do not
count.

## A worked example

Both sides start from this document:

```markdown
# Release plan

The release ships on Monday.

## Testing

Testing starts on Friday.

## Contacts

Ask the release team.
```

Before the next run, someone changes it in git:

```markdown
# Release plan

The release ships on Tuesday.

## Testing

Testing starts on Friday.

## Contacts

Ask the release team in the team chat.
```

and someone else changes it in Linear:

```markdown
# Release plan

The release ships on Wednesday.

## Testing

Testing starts on Thursday.

## Contacts

Ask the release team.
```

The run merges them. The Testing and Contacts edits touch different
paragraphs and both land. The first paragraph was changed on both sides, so
it becomes a conflict:

```markdown
# Release plan

**Sync conflict: git version**

The release ships on Tuesday.

**Sync conflict: Linear version**

The release ships on Wednesday.

**Sync conflict: end**

## Testing

Testing starts on Thursday.

## Contacts

Ask the release team in the team chat.
```

### In Linear

- The document shows this text, with the marker paragraphs in bold.
- Its icon becomes the orange `Alert` icon. If the document had its own icon
  and color, the sync keeps them and puts them back exactly once the
  conflict is resolved. If the repository's security checks also reject the
  document, their red `Cross` icon and comment show instead until the
  finding is fixed; then the `Alert` icon and the conflict comment return.
- The sync adds one comment, once per conflict:

  > This document contains conflicting versions. Edit the document here or
  > in Git, keep the text you want, and remove every conflict marker
  > paragraph throughout the document. The alert clears after the next sync.

### In git

- The sync pull request brings the same text into the file on the tracked
  branch, and merges like any other sync pull request. Nothing blocks it,
  and other documents' changes reach git in the same run.
- The summary of the run that writes the conflict counts the documents with
  conflict markers and lists them in its "Conflict markers" table, by path.
  Later runs do not list a conflict again while it stays open: search the
  files for `Sync conflict:` to find every open one.

## Resolving a conflict

Resolve it on either side, by editing the text. No command or setting is
needed.

1. Keep the text you want. That can be one of the versions, both, or a new
   text that combines them.
2. Remove all three marker paragraphs, and every other marker paragraph of
   the document.

For the example above, the resolved paragraph might be:

```markdown
# Release plan

The release ships on Tuesday.
```

**In Linear:** edit the document. The next run takes the edit to the tracked
branch through the sync pull request, removes the `Alert` icon and puts the
document's own icon and color back.

**In git:** edit the file on the tracked branch, commit and push. The next run
writes the text to Linear and removes the `Alert` icon in the same way.

While you resolve:

- **Removing only some marker lines** keeps the document in conflict: the
  icon stays until every marker line is gone.
- **Editing inside the markers** without resolving is an ordinary edit. It
  reaches the other side, and the markers and the icon stay.
- **If both sides change the same lines again** before the conflict is
  resolved, the next run writes a new conflict in place of the old one.
  Markers are never nested.

## Whole tables, code blocks and lists

Markers in the middle of a table, a code block or a list would break it: a
table split by a marker paragraph loses its rows. So a conflict inside one of
these takes in the whole block, and each version is a complete table, code
block or list:

- tables;
- code blocks, including Mermaid diagrams;
- quotes and HTML blocks;
- ordered lists, and lists with nested items.

For example, both sides start from this table, git changes `Ana` to `Ada`
and Linear changes it to `Ann` (the three versions, in that order):

```markdown
# Owners

| Area | Owner |
| --- | --- |
| Docs | Ana |
| Build | Ben |
```

```markdown
# Owners

| Area | Owner |
| --- | --- |
| Docs | Ada |
| Build | Ben |
```

```markdown
# Owners

| Area | Owner |
| --- | --- |
| Docs | Ann |
| Build | Ben |
```

the conflict holds both tables in full:

```markdown
# Owners

**Sync conflict: git version**

| Area | Owner |
| --- | --- |
| Docs | Ada |
| Build | Ben |

**Sync conflict: Linear version**

| Area | Owner |
| --- | --- |
| Docs | Ann |
| Build | Ben |

**Sync conflict: end**
```

A flat bullet list, without nesting, stays line by line: the markers go
around the changed bullet only.

## Images

When the two sides add different images at the same spot, the conflict
holds both, and each version's image keeps working on both sides. An image
pasted in Linear is stored as a file in the repository and linked relative
to the document, and an image file from git is uploaded to Linear. Whichever
version you keep, its image is already in place.

## Deletes and renames

A conflict can also be about the document itself: one side deletes or
renames it while the other edits or renames it. These are decided by rules,
not by markers, and the rules never lose an edit:

- **A change beats a delete.** A change is an edit or a rename. A deleted
  document is easier to delete again than lost work is to find.
- **When both sides rename, git's path wins.** Paths are the repository's
  structure, and other files link to them.
- **The text is always merged**, never chosen. If both sides also edited the
  same paragraph, the result gets the usual conflict markers.
- **There is never a second copy.** Each case ends with at most one document
  and one file.

"Deleted" in Linear includes a document moved to trash, and one moved to a
project or team that no synchronized folder maps. A move between folders,
projects or teams is a rename. A change of line endings or of the Unicode
form of a file name is neither an edit nor a rename.

| Git | Linear | Result | Run summary |
| --- | --- | --- | --- |
| deleted | edited or renamed | The document stays as Linear has it. Its file comes back on the tracked branch through the sync pull request. | `edit-wins-delete` |
| edited or renamed | deleted | The same document is restored in Linear, out of trash or back into its project or team, with the git text and title. Its comments stay as they were. | `edit-wins-delete` |
| deleted | deleted | Removed on both sides. | none |
| renamed | edited | Both apply: the git path, the merged text. Linear's title follows the path. | `rename-and-edit`, when the text also conflicts |
| edited | renamed | Both apply: Linear's path, the merged text. The file moves on the tracked branch through the sync pull request. | `rename-and-edit`, when the text also conflicts |
| renamed | renamed to the same path | One rename, the merged text. | none |
| renamed | renamed to another path | Git's path wins. Linear's title is set back to match it, and the document gets a comment. The merged text. | `git-path-wins` |

A rename on one side with no change on the other is an ordinary rename, and
a delete on one side with no change on the other is an ordinary delete. A
rename on one side and an edit on the other that git's merge combines on
its own, because the text does not conflict, is ordinary too. The run
summary reports those as renames, moves and deletes.

The comment on a title set back reads:

> The title was set back because the file was renamed in git at the same
> time. Rename it again to change it.

A restored document gets no comment, so its comments stay exactly as they
were. If Linear no longer has the document at all (it was removed from
trash for good), the sync creates a new document with the git text. The text
survives; the old document's comments do not, and the run summary says so.

Each case a rule decided is one row of the run summary's "Decided by the
conflict rules" table: the rule's code from the table above, and a line that
names the paths and what happened, never the document's content.
