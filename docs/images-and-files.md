# Images and files

How images and other files travel between git and Linear, what the sync
accepts, and what happens when a file cannot be synced.

## Where files live

- **In git,** a file is an ordinary file of the repository, or a Git LFS
  object when your `.gitattributes` says so ([Git LFS](usage.md#git-lfs)).
- **In Linear,** the same file is an upload in Linear's own storage.

The sync keeps the two as one set: each file is uploaded to Linear once
and reused, and each upload taken from Linear is stored once per folder in
git.

## From git to Linear

Files a document links are uploaded to Linear once. An image must be a
relative path to a file of the repository; the `linear-format` hook reports
other images ([image-not-in-repository](linear-format.md#image-not-in-repository)).
External images are never downloaded, and repaired paths stay plain links
and do not upload repository files.

## From Linear to git

Images and documents pasted in Linear land in an `assets/` folder beside
the document, one per folder, named by content (`assets/<sha256>.png`).
Downloaded files use the extension detected from their bytes, regardless of
the upload URL or declared content type.

- Files you committed keep their place.
- A document moved to another folder takes copies of its `assets/` files.
- Lint refuses Markdown files inside an `assets/` folder.

## What is repaired

- External HTTP(S) images, path images and uploads returning 404 or 410
  become ordinary links. An empty alt text uses the URL as its label, and
  an image inside a link keeps the outer link.
- Empty images and `data:` images are removed.
- Links with schemes other than HTTP, HTTPS or `mailto` are removed with
  their text on pull and refused by lint on push. Paths and fragments are
  allowed.

The sync pull request lists every changed image by its place and Markdown
line; after the merge, the link version is written back to Linear.

## What is accepted

New uploads must contain PNG, JPEG, GIF, WebP, AVIF, PDF, MP4, WebM or SVG,
identified from their bytes. An SVG is blocked when it has `script` or
`foreignObject` elements, animation elements, event attributes,
`xml:base` or non-fragment `href` references.

Files already in the repository keep working, except a file an earlier sync
captured (named `<sha256>.<ext>`) that the check now refuses: a document
that links it again from Linear is blocked, and `mdbisync lint` names the
file (`upload-file-refused`) for you to remove or replace.

## When a file cannot be synced

- An unsafe upload, an unreadable one (including redirects) or a file
  larger than 10 MB blocks the document with a red mark and a comment.
  Fixing it clears the comment and restores the icon.
- Access errors stop capture.
- A temporary download failure leaves the document unmarked and listed as
  `download-retry` in the run summary until a later run succeeds.

See [files left out](troubleshooting.md#files-left-out) for every code.
