// What the sync merges into the tracked branch by itself.
//
// The sync branch keeps commits a person or a CI job adds to it, and the App
// that merges the sync pull request may bypass the tracked branch's review
// rule. So before either lane merges, the sync reads what the merge would
// change on the tracked branch, whoever made the commits: only documents and
// the asset types the sync writes, as regular files under an annotated
// folder and outside any `.github` folder, and never a folder's Linear
// annotation. Any other change leaves the pull request to a person.

import { ANNOTATION_FILE, folderOf, nearestZone, readAnnotation, type Zone } from '../mapping/annotations.ts';
import { MARKDOWN_EXTENSION } from '../mapping/index.ts';
import { type Git, type Oid, readBlobs } from '../state/index.ts';
import { UPLOAD_EXTENSIONS } from './upload-type.ts';

/** Modes the sync merges a file in: a regular file, or none (removed). */
const MERGED_MODES = new Set(['100644', '100755', '000000']);
const NO_BLOB = '0'.repeat(40);

/** Whether a change of `path` to `mode` is one the sync merges by itself, by its path and mode alone. */
export function isSyncedChange(path: string, mode: string, zones: ReadonlyMap<string, Zone>): boolean {
  if (!MERGED_MODES.has(mode)) return false;
  if (path.split('/').some((segment) => segment.toLowerCase() === '.github')) return false;
  // As the mapping and the asset writer spell them: lowercase, after a name.
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  if (extension !== MARKDOWN_EXTENSION && !UPLOAD_EXTENSIONS.has(extension)) return false;
  return nearestZone(zones, folderOf(path)) !== undefined;
}

/**
 * Whether a `README.md` change keeps its folder's annotation: the Linear team
 * and project its documents go to. A body edit from Linear keeps it; a change
 * that adds, edits or removes the annotation sends documents elsewhere and is
 * a person's to review.
 */
export function keepsAnnotation(path: string, before: string | null, after: string | null): boolean {
  const read = (text: string | null) => JSON.stringify(text === null ? { annotation: null } : readAnnotation(path, text));
  return read(before) === read(after);
}

/** At most this many files are named in a description or a message; the rest are counted. */
export const LISTED_UNVERIFIED = 20;

/** A file name on one line: a control character in it, a line break among them, becomes `?`. */
export function oneLine(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/** One file name as code: someone else chose it, so a backtick or a line break in it cannot end the span or the line. */
function quoted(path: string): string {
  return `\`${oneLine(path).replaceAll('`', '?')}\``;
}

/** The files, quoted, the first `LISTED_UNVERIFIED` of them and a count of the rest. */
export function unverifiedList(paths: readonly string[]): string {
  const named = paths.slice(0, LISTED_UNVERIFIED).map(quoted).join(', ');
  return paths.length > LISTED_UNVERIFIED ? `${named} and ${paths.length - LISTED_UNVERIFIED} more` : named;
}

/** The paragraph a sync pull request's description gets when the sync leaves its merge to a person. */
export function unverifiedNote(paths: readonly string[]): string {
  return `The sync does not merge this pull request: it also changes files that are not synchronized documents or their assets (${paths.length}): ${unverifiedList(paths)}. A person reviews and merges it, or removes those changes from this branch.`;
}

/**
 * Paths whose change from `before` to `after` (two trees: the tracked
 * branch, and the tracked branch with the head merged in) the sync does not
 * merge by itself, sorted; empty when it may merge.
 */
export async function unverifiedPaths(git: Git, before: Oid | string, after: Oid | string, zones: ReadonlyMap<string, Zone>): Promise<string[]> {
  const raw = (await git.run(['diff-tree', '-r', '-z', '--no-renames', '--raw', before, after])).stdout.toString('utf8');
  const fields = raw.split('\0');
  const paths: string[] = [];
  const readmes: Array<{ path: string; from: string; to: string }> = [];
  // Each change is `:<old mode> <new mode> <old oid> <new oid> <status>` and its path.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode = '', from = NO_BLOB, to = NO_BLOB] = (fields[index] as string).split(' ');
    const path = fields[index + 1] as string;
    if (!isSyncedChange(path, mode, zones)) paths.push(path);
    else if (path.split('/').at(-1) === ANNOTATION_FILE) readmes.push({ path, from, to });
  }
  if (readmes.length > 0) {
    const blobs = await readBlobs(git, readmes.flatMap(({ from, to }) => [from, to].filter((oid) => oid !== NO_BLOB)));
    const text = (oid: string) => oid === NO_BLOB ? null : (blobs.get(oid) as Buffer).toString('utf8');
    for (const { path, from, to } of readmes) if (!keepsAnnotation(path, text(from), text(to))) paths.push(path);
  }
  return paths.sort();
}
